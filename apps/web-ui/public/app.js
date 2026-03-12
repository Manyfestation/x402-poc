import { deriveAddressCandidates, inspectQuoteTransaction, signQuoteTransaction } from "./kaspa-wallet.js";

const X402_VERSION = 2;
const PAYMENT_REQUIRED_HEADER = "payment-required";
const PAYMENT_SIGNATURE_HEADER = "payment-signature";
const PAYMENT_RESPONSE_HEADER = "payment-response";
const PAYMENT_IDENTIFIER_EXTENSION = "payment-identifier";
const TX_FORMAT = "kaspa-unsigned-transaction-v1";

const state = {
  config: null,
  wallet: null,
  walletCandidates: null,
  paymentRequired: null,
  paymentRequirements: null,
  paymentId: null,
  quote: null,
  paymentPayload: null,
  settlementResponse: null,
  finalResult: null
};

const els = {
  flowHint: document.querySelector("#flowHint"),
  networkLabel: document.querySelector("#networkLabel"),
  stepChallenge: document.querySelector("#stepChallenge"),
  stepPay: document.querySelector("#stepPay"),
  stepUnlock: document.querySelector("#stepUnlock"),
  merchantState: document.querySelector("#merchantState"),
  merchantMessage: document.querySelector("#merchantMessage"),
  amountDue: document.querySelector("#amountDue"),
  paymentId: document.querySelector("#paymentId"),
  contentBox: document.querySelector("#contentBox"),
  clientState: document.querySelector("#clientState"),
  clientMessage: document.querySelector("#clientMessage"),
  payerAddress: document.querySelector("#payerAddress"),
  quoteId: document.querySelector("#quoteId"),
  txId: document.querySelector("#txId"),
  txLink: document.querySelector("#txLink"),
  terminalLog: document.querySelector("#terminalLog"),
  configJson: document.querySelector("#configJson"),
  challengeJson: document.querySelector("#challengeJson"),
  quoteJson: document.querySelector("#quoteJson"),
  paymentJson: document.querySelector("#paymentJson"),
  receiptJson: document.querySelector("#receiptJson"),
  finalJson: document.querySelector("#finalJson"),
  payButton: document.querySelector("#payButton"),
  resetFlow: document.querySelector("#resetFlow")
};

const STEP_LABELS = {
  pending: "Pending",
  active: "Active",
  done: "Done",
  error: "Error"
};

function setMerchantState(label, kind) {
  els.merchantState.textContent = label;
  els.merchantState.className = `pill ${kind}`;
}

function setClientState(label, kind) {
  els.clientState.textContent = label;
  els.clientState.className = `pill ${kind}`;
}

function setStepState(stepEl, kind) {
  stepEl.dataset.state = kind;
  const labelEl = stepEl.querySelector(".step-state");
  if (labelEl) {
    labelEl.textContent = STEP_LABELS[kind] ?? kind;
  }
}

function setJourneyStage(hint, steps) {
  els.flowHint.textContent = hint;
  setStepState(els.stepChallenge, steps.challenge);
  setStepState(els.stepPay, steps.pay);
  setStepState(els.stepUnlock, steps.unlock);
}

function getErrorSteps() {
  if (!state.paymentRequired) {
    return { challenge: "error", pay: "pending", unlock: "pending" };
  }

  if (!state.paymentPayload) {
    return { challenge: "done", pay: "error", unlock: "pending" };
  }

  return { challenge: "done", pay: "done", unlock: "error" };
}

function syncNetworkLabel() {
  els.networkLabel.textContent = state.paymentRequirements?.network ?? state.config?.networkId ?? "-";
}

function setTxLink(url, label, enabled = false) {
  els.txLink.href = enabled ? url : "#";
  els.txLink.textContent = label;
  els.txLink.classList.toggle("is-muted", !enabled);
}

function formatJson(value) {
  if (value == null) {
    return "-";
  }

  if (typeof value === "string") {
    return value;
  }

  return JSON.stringify(value, null, 2);
}

function setPayload(el, value) {
  el.textContent = formatJson(value);
}

function logTerminal(stage, message, payload) {
  const timestamp = new Date().toLocaleTimeString("en-GB", { hour12: false });
  const lines = [`[${timestamp}] [${stage}] ${message}`];
  if (payload !== undefined) {
    lines.push(formatJson(payload));
  }

  els.terminalLog.textContent = `${els.terminalLog.textContent}\n\n${lines.join("\n")}`.trim();
  els.terminalLog.scrollTop = els.terminalLog.scrollHeight;
}

function buildExplorerUrl(txid) {
  return `${state.config.explorerBaseUrl}${txid}`;
}

function getErrorDetails(error) {
  if (!(error instanceof Error)) {
    return { message: String(error) };
  }

  return {
    message: error.message,
    status: error.status,
    url: error.url,
    payload: error.payload
  };
}

function createPaymentId() {
  return `payment_${crypto.randomUUID().replaceAll("-", "")}`;
}

function resetViews() {
  state.paymentRequired = null;
  state.paymentRequirements = null;
  state.paymentId = null;
  state.quote = null;
  state.paymentPayload = null;
  state.settlementResponse = null;
  state.finalResult = null;
  els.quoteId.textContent = "-";
  els.txId.textContent = "-";
  els.paymentId.textContent = "-";
  els.amountDue.textContent = "-";
  els.contentBox.textContent = "Payment required";
  els.contentBox.className = "content locked-content";
  els.clientMessage.textContent = "Waiting for merchant challenge.";
  els.merchantMessage.textContent = "Loading paywall…";
  setMerchantState("Locked", "locked");
  setClientState("Idle", "idle");
  els.payButton.disabled = true;
  els.payButton.textContent = "Pay";
  els.terminalLog.textContent = "[boot] Waiting for merchant challenge…";
  setTxLink("#", "Awaiting TN12 tx", false);
  syncNetworkLabel();
  setJourneyStage(
    "Loading the protected resource and waiting for the merchant challenge.",
    { challenge: "active", pay: "pending", unlock: "pending" }
  );
  setPayload(els.challengeJson, null);
  setPayload(els.quoteJson, null);
  setPayload(els.paymentJson, null);
  setPayload(els.receiptJson, null);
  setPayload(els.finalJson, null);
}

function encodeJsonHeader(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeJsonHeader(value) {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(state.config?.httpTimeoutMs ?? 10_000)
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const error = new Error(payload?.error ?? `request failed with ${response.status}`);
    error.status = response.status;
    error.url = url;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function paymentRequirementsMatch(left, right) {
  if (!left || !right) {
    return false;
  }

  return left.scheme === right.scheme &&
    left.network === right.network &&
    left.amount === right.amount &&
    left.asset === right.asset &&
    left.payTo === right.payTo &&
    left.maxTimeoutSeconds === right.maxTimeoutSeconds &&
    left.extra?.maxFeeSompi === right.extra?.maxFeeSompi &&
    left.extra?.txFormat === right.extra?.txFormat;
}

function verifyQuote() {
  const quote = state.quote;
  const paymentRequirements = state.paymentRequirements;
  const summary = quote.signingSummary;
  const allowedPayerAddresses = Array.isArray(state.walletCandidates) && state.walletCandidates.length > 0
    ? state.walletCandidates
    : [state.config.payerAddress];

  if (!paymentRequirementsMatch(quote.paymentRequirements, paymentRequirements)) {
    throw new Error("quote payment requirements mismatch");
  }

  if (quote.txFormat !== TX_FORMAT) {
    throw new Error(`unexpected tx format: ${quote.txFormat}`);
  }

  if (!quote.unsignedTransaction || typeof quote.unsignedTransaction !== "string") {
    throw new Error("quote is missing an unsigned transaction payload");
  }

  if (summary.merchantAddress !== paymentRequirements.payTo) {
    throw new Error("merchant output address mismatch");
  }

  if (!allowedPayerAddresses.includes(quote.payerContext?.payerAddress)) {
    throw new Error("quote payer address mismatch");
  }

  if (String(summary.transferAmountSompi) !== paymentRequirements.amount) {
    throw new Error("merchant output amount mismatch");
  }

  if (summary.feeSompi > paymentRequirements.extra.maxFeeSompi) {
    throw new Error("quoted fee exceeds requirement max fee");
  }

  if (!allowedPayerAddresses.includes(summary.payerAddress)) {
    throw new Error("payer address mismatch");
  }

  if (!Array.isArray(summary.selectedInputs) || summary.selectedInputs.length === 0) {
    throw new Error("quote is missing payer inputs");
  }

  if (summary.txCount !== 1) {
    throw new Error(`quote returned ${summary.txCount} transactions`);
  }

  if (summary.totalInputSompi !== summary.transferAmountSompi + summary.changeAmountSompi + summary.feeSompi) {
    throw new Error("summary totals do not balance");
  }
}

function buildPaymentPayload(signedTransaction) {
  return {
    x402Version: X402_VERSION,
    resource: state.paymentRequired.resource,
    accepted: state.paymentRequirements,
    payload: {
      quoteId: state.quote.quoteId,
      transaction: signedTransaction,
      txFormat: TX_FORMAT
    },
    extensions: {
      [PAYMENT_IDENTIFIER_EXTENSION]: {
        info: {
          paymentId: state.paymentId
        },
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            paymentId: {
              type: "string"
            }
          }
        }
      }
    }
  };
}

async function loadPaywall() {
  resetViews();
  if (state.config) {
    logTerminal("boot", "Loaded client config", state.config);
  }
  logTerminal("merchant", "GET /api/merchant/premium");
  const response = await fetch("/api/merchant/premium", {
    signal: AbortSignal.timeout(state.config?.httpTimeoutMs ?? 10_000)
  });

  if (response.status !== 402) {
    throw new Error(`expected 402 but received ${response.status}`);
  }

  const paymentRequiredHeader = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!paymentRequiredHeader) {
    throw new Error("merchant returned 402 without PAYMENT-REQUIRED");
  }

  state.paymentRequired = decodeJsonHeader(paymentRequiredHeader);
  state.paymentRequirements = state.paymentRequired.accepts[0];
  state.paymentId = createPaymentId();
  setPayload(els.challengeJson, state.paymentRequired);
  syncNetworkLabel();
  els.amountDue.textContent = `${state.paymentRequirements.amount} sompi`;
  els.paymentId.textContent = state.paymentId;
  els.merchantMessage.textContent = "402 returned. Waiting for PAYMENT-SIGNATURE.";
  els.clientMessage.textContent = "Challenge received. Ready to pay.";
  setMerchantState("Locked", "locked");
  setClientState("Ready", "ready");
  setJourneyStage(
    "Merchant requested payment. Press Pay to prepare, inspect, and sign the Kaspa transaction.",
    { challenge: "done", pay: "active", unlock: "pending" }
  );
  logTerminal("merchant", "Received PAYMENT-REQUIRED challenge", state.paymentRequired);
  els.payButton.disabled = false;
  els.payButton.textContent = "Pay";
}

async function runPayment() {
  try {
    els.payButton.disabled = true;
    els.payButton.textContent = "Paying...";
    setClientState("Paying", "active");
    els.clientMessage.textContent = "Preparing payment.";
    setJourneyStage(
      "Preparing the payment, verifying the PSKB locally, and retrying with PAYMENT-SIGNATURE.",
      { challenge: "done", pay: "active", unlock: "pending" }
    );

    logTerminal("facilitator", "POST /api/facilitator/prepare", {
      paymentRequirements: state.paymentRequirements,
      payerAddresses: state.walletCandidates
    });
    state.quote = await fetchJson("/api/facilitator/prepare", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentRequirements: state.paymentRequirements,
        payerAddress: state.config.payerAddress,
        payerAddresses: state.walletCandidates
      })
    });
    setPayload(els.quoteJson, state.quote);
    els.quoteId.textContent = state.quote.quoteId;
    logTerminal("facilitator", "Received unsigned transaction quote", {
      quoteId: state.quote.quoteId,
      txFormat: state.quote.txFormat,
      signingSummary: state.quote.signingSummary
    });

    verifyQuote();
    const pskbInspection = await inspectQuoteTransaction({
      unsignedTransaction: state.quote.unsignedTransaction,
      networkId: state.config.networkId,
      requirement: state.paymentRequirements,
      signingSummary: state.quote.signingSummary
    });
    els.payerAddress.textContent = shortId(state.quote.payerContext?.payerAddress ?? state.config.payerAddress);
    logTerminal("client", "Verified quote against the x402 requirements and payer wallet", {
      paymentId: state.paymentId,
      merchantAddress: state.paymentRequirements.payTo,
      amountSompi: state.paymentRequirements.amount,
      payerAddress: state.quote.payerContext?.payerAddress ?? state.config.payerAddress,
      pskbOutputs: pskbInspection.outputs
    });

    els.clientMessage.textContent = "Signing locally.";
    logTerminal("wallet", "Signing unsigned transaction in browser", {
      networkId: state.config.networkId,
      unsignedTransactionLength: state.quote.unsignedTransaction?.length
    });
    const signed = await signQuoteTransaction({
      unsignedTransaction: state.quote.unsignedTransaction,
      mnemonic: state.wallet.mnemonic,
      networkId: state.config.networkId
    });

    state.paymentPayload = buildPaymentPayload(signed.signedTransaction);
    setPayload(els.paymentJson, state.paymentPayload);
    logTerminal("wallet", "Signed PSKB locally; retrying merchant request with PAYMENT-SIGNATURE", {
      quoteId: state.quote.quoteId,
      paymentId: state.paymentId
    });

    const paymentSignatureHeader = encodeJsonHeader(state.paymentPayload);
    logTerminal("merchant", "GET /api/merchant/premium with PAYMENT-SIGNATURE", {
      paymentSignatureHeader,
      paymentPayload: state.paymentPayload
    });
    const paidResponse = await fetch("/api/merchant/premium", {
      signal: AbortSignal.timeout(state.config?.httpTimeoutMs ?? 10_000),
      headers: {
        [PAYMENT_SIGNATURE_HEADER]: paymentSignatureHeader
      }
    });
    const paidBody = await paidResponse.text();
    const paymentResponseHeader = paidResponse.headers.get(PAYMENT_RESPONSE_HEADER);
    state.settlementResponse = paymentResponseHeader ? decodeJsonHeader(paymentResponseHeader) : null;
    setPayload(els.receiptJson, state.settlementResponse);

    if (state.settlementResponse?.transaction) {
      els.txId.textContent = shortId(state.settlementResponse.transaction);
      setTxLink(
        buildExplorerUrl(state.settlementResponse.transaction),
        buildExplorerUrl(state.settlementResponse.transaction),
        true
      );
    }

    if (!paidResponse.ok) {
      throw new Error(
        state.settlementResponse?.errorReason
          ? `payment failed: ${state.settlementResponse.errorReason}`
          : `paid request failed with ${paidResponse.status}`
      );
    }

    state.finalResult = {
      status: paidResponse.status,
      body: paidBody
    };
    setPayload(els.finalJson, state.finalResult);

    setMerchantState("Unlocked", "unlocked");
    setClientState("Done", "done");
    els.merchantMessage.textContent = "PAYMENT-RESPONSE accepted.";
    els.clientMessage.textContent = "Payment complete.";
    els.contentBox.textContent = paidBody;
    els.contentBox.className = "content unlocked-content";
    els.payButton.textContent = "Paid";
    setJourneyStage(
      "Payment complete. The merchant verified and settled the PAYMENT-SIGNATURE payload.",
      { challenge: "done", pay: "done", unlock: "done" }
    );
    logTerminal("merchant", "Merchant unlocked premium content", {
      finalResult: state.finalResult,
      settlementResponse: state.settlementResponse
    });
  } catch (error) {
    const details = getErrorDetails(error);
    setClientState("Error", "error");
    els.clientMessage.textContent = details.message;
    els.payButton.textContent = "Retry Pay";
    setJourneyStage(`Flow blocked: ${details.message}`, getErrorSteps());
    setPayload(els.finalJson, {
      step: state.paymentPayload ? "merchant-settlement" : "payment",
      settlementResponse: state.settlementResponse,
      ...details
    });
    logTerminal("error", details.message, {
      ...details,
      settlementResponse: state.settlementResponse
    });
  } finally {
    els.payButton.disabled = Boolean(state.settlementResponse?.success);
  }
}

function shortId(value) {
  if (!value || value.length < 12) {
    return value ?? "-";
  }

  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

async function boot() {
  state.config = await fetchJson("/api/config");
  window.__x402Config = state.config;
  state.wallet = await fetchJson("/api/wallet-session");
  state.walletCandidates = await deriveAddressCandidates({
    mnemonic: state.wallet.mnemonic,
    networkId: state.config.networkId
  });
  els.payerAddress.textContent = shortId(state.config.payerAddress);
  syncNetworkLabel();
  setPayload(els.configJson, state.config);
  await loadPaywall();
}

els.payButton.addEventListener("click", runPayment);
els.resetFlow.addEventListener("click", () => {
  loadPaywall().catch((error) => {
    setClientState("Error", "error");
    const message = error instanceof Error ? error.message : String(error);
    els.clientMessage.textContent = message;
    setJourneyStage(`Flow blocked: ${message}`, getErrorSteps());
  });
});

boot().catch((error) => {
  setClientState("Error", "error");
  const message = error instanceof Error ? error.message : String(error);
  els.clientMessage.textContent = message;
  setJourneyStage(`Flow blocked: ${message}`, getErrorSteps());
});
