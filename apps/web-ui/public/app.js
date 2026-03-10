import { deriveAddressCandidates, inspectQuoteTransaction, signQuoteTransaction } from "./kaspa-wallet.js";

const state = {
  config: null,
  wallet: null,
  walletCandidates: null,
  requirement: null,
  quote: null,
  receipt: null,
  payment: null,
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
  if (!state.requirement) {
    return { challenge: "error", pay: "pending", unlock: "pending" };
  }

  if (!state.payment) {
    return { challenge: "done", pay: "error", unlock: "pending" };
  }

  return { challenge: "done", pay: "done", unlock: "error" };
}

function syncNetworkLabel() {
  els.networkLabel.textContent = state.requirement?.network ?? state.config?.networkId ?? "-";
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

function resetViews() {
  state.requirement = null;
  state.quote = null;
  state.receipt = null;
  state.payment = null;
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

function base64UrlEncode(value) {
  return btoa(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
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

function verifyQuote() {
  const quote = state.quote;
  const requirement = state.requirement;
  const summary = quote.signingSummary;
  const allowedPayerAddresses = Array.isArray(state.walletCandidates) && state.walletCandidates.length > 0
    ? state.walletCandidates
    : [state.config.payerAddress];

  const comparedFields = [
    "paymentId",
    "resource",
    "merchantAddress",
    "amountSompi",
    "maxFeeSompi",
    "facilitatorUrl",
    "network"
  ];
  for (const field of comparedFields) {
    if (quote.requirement[field] !== requirement[field]) {
      throw new Error(`quote requirement mismatch for ${field}`);
    }
  }

  if (quote.txFormat !== "kaspa-unsigned-transaction-v1") {
    throw new Error(`unexpected tx format: ${quote.txFormat}`);
  }

  if (!quote.unsignedTransaction || typeof quote.unsignedTransaction !== "string") {
    throw new Error("quote is missing an unsigned transaction payload");
  }

  if (summary.merchantAddress !== requirement.merchantAddress) {
    throw new Error("merchant output address mismatch");
  }

  if (!allowedPayerAddresses.includes(quote.payerContext?.payerAddress)) {
    throw new Error("quote payer address mismatch");
  }

  if (summary.transferAmountSompi !== requirement.amountSompi) {
    throw new Error("merchant output amount mismatch");
  }

  if (summary.feeSompi > requirement.maxFeeSompi) {
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

async function loadPaywall() {
  resetViews();
  if (state.config) {
    logTerminal("boot", "Loaded client config", state.config);
  }
  logTerminal("merchant", "GET /api/merchant/premium");
  const response = await fetch("/api/merchant/premium", {
    signal: AbortSignal.timeout(state.config?.httpTimeoutMs ?? 10_000)
  });
  const payload = await readJson(response);

  if (response.status !== 402) {
    throw new Error(`expected 402 but received ${response.status}`);
  }

  state.requirement = payload.requirement;
  setPayload(els.challengeJson, payload);
  syncNetworkLabel();
  els.amountDue.textContent = `${payload.requirement.amountSompi} sompi`;
  els.paymentId.textContent = payload.requirement.paymentId;
  els.merchantMessage.textContent = "402 returned. Waiting for payment.";
  els.clientMessage.textContent = "Challenge received. Ready to pay.";
  setMerchantState("Locked", "locked");
  setClientState("Ready", "ready");
  setJourneyStage(
    "Merchant requested payment. Press Pay to settle the request.",
    { challenge: "done", pay: "active", unlock: "pending" }
  );
  logTerminal("merchant", "Received 402 payment challenge", payload);
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
      "Preparing the payment, verifying it, and broadcasting to TN12.",
      { challenge: "done", pay: "active", unlock: "pending" }
    );

    logTerminal("facilitator", "POST /api/facilitator/quotes", {
      requirement: state.requirement,
      payerAddresses: state.walletCandidates
    });
    state.quote = await fetchJson("/api/facilitator/quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement: state.requirement,
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
      requirement: state.requirement,
      signingSummary: state.quote.signingSummary
    });
    els.payerAddress.textContent = shortId(state.quote.payerContext?.payerAddress ?? state.config.payerAddress);
    logTerminal("client", "Verified quote against merchant challenge and payer wallet", {
      paymentId: state.requirement.paymentId,
      merchantAddress: state.requirement.merchantAddress,
      amountSompi: state.requirement.amountSompi,
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
    setPayload(els.paymentJson, {
      signedLocally: true,
      signedTransactionLength: signed.signedTransaction?.length
    });
    logTerminal("wallet", "Signed PSKB locally; submitting it to the facilitator", {
      quoteId: state.quote.quoteId
    });

    state.receipt = await fetchJson("/api/facilitator/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        quoteId: state.quote.quoteId,
        signedTransaction: signed.signedTransaction
      })
    });
    state.payment = {
      txid: state.receipt.txid,
      payerAddress: state.config.payerAddress
    };
    setPayload(els.paymentJson, {
      ...state.payment,
      explorerUrl: buildExplorerUrl(state.payment.txid)
    });
    els.txId.textContent = shortId(state.payment.txid);
    setTxLink(buildExplorerUrl(state.payment.txid), buildExplorerUrl(state.payment.txid), true);
    setJourneyStage(
      "Payment sent. Waiting for receipt validation and merchant unlock.",
      { challenge: "done", pay: "done", unlock: "active" }
    );
    logTerminal("facilitator", "Facilitator broadcast and verified the TN12 transaction", {
      txid: state.payment.txid,
      explorerUrl: buildExplorerUrl(state.payment.txid)
    });
    setPayload(els.receiptJson, state.receipt);
    logTerminal("facilitator", "Received payment receipt", state.receipt);

    const receiptHeader = base64UrlEncode(JSON.stringify(state.receipt));
    logTerminal("merchant", "GET /api/merchant/premium with x-payment-receipt", {
      receiptHeader,
      receipt: state.receipt
    });
    const paidResponse = await fetch("/api/merchant/premium", {
      signal: AbortSignal.timeout(state.config?.httpTimeoutMs ?? 10_000),
      headers: {
        "x-payment-receipt": receiptHeader
      }
    });
    const paidBody = await paidResponse.text();
    if (!paidResponse.ok) {
      throw new Error(`paid request failed with ${paidResponse.status}`);
    }
    state.finalResult = {
      status: paidResponse.status,
      body: paidBody
    };
    setPayload(els.finalJson, state.finalResult);

    setMerchantState("Unlocked", "unlocked");
    setClientState("Done", "done");
    els.merchantMessage.textContent = "Receipt accepted.";
    els.clientMessage.textContent = "Payment complete.";
    els.contentBox.textContent = paidBody;
    els.contentBox.className = "content unlocked-content";
    els.payButton.textContent = "Paid";
    setJourneyStage(
      "Payment complete. The merchant accepted the receipt and unlocked the content.",
      { challenge: "done", pay: "done", unlock: "done" }
    );
    logTerminal("merchant", "Merchant unlocked premium content", state.finalResult);
  } catch (error) {
    const details = getErrorDetails(error);
    setClientState("Error", "error");
    els.clientMessage.textContent = details.message;
    els.payButton.textContent = "Retry Pay";
    setJourneyStage(`Flow blocked: ${details.message}`, getErrorSteps());
    setPayload(els.finalJson, {
      step: state.payment ? "merchant-unlock" : "payment",
      ...details
    });
    logTerminal("error", details.message, details);
  } finally {
    els.payButton.disabled = Boolean(state.receipt);
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
