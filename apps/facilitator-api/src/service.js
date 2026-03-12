import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_ASSET,
  DEFAULT_NETWORK,
  REAL_TX_FORMAT,
  SCHEME_NAME,
  X402_VERSION,
  assertPaymentRequirements,
  assertVerifyRequest,
  createId,
  createSettlementResponse,
  createSupportedResponse,
  getKaspaMaxFeeSompi,
  getKaspaTxFormat,
  getPaymentIdFromExtensions,
  samePaymentRequirements
} from "@x402-kaspa/protocol";
import {
  FACILITATOR_URL
} from "@x402-kaspa/test-kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_FILE = path.resolve(__dirname, "../.data/facilitator-state.json");

function unsupportedMessage(kind) {
  return `the active TN12 facilitator runtime is the Rust service behind \`npm run facilitator\`; ${kind} is unavailable in the JS test double`;
}

async function unsupportedQuoteBuilder() {
  throw new Error(unsupportedMessage("quote preparation"));
}

async function unsupportedPaymentSettler() {
  throw new Error(unsupportedMessage("payment settlement"));
}

function loadPayments(stateFile) {
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
    return new Map(payments.map((payment) => [payment.paymentId, payment]));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return new Map();
    }

    throw error;
  }
}

function persistPayments(stateFile, payments) {
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify(
      {
        payments: [...payments.values()]
      },
      null,
      2
    )
  );
}

function validateSupportedPaymentRequirements({ network, asset }, paymentRequirements) {
  assertPaymentRequirements(paymentRequirements);

  if (paymentRequirements.network !== network) {
    throw new Error("payment requirements use an unexpected network");
  }

  if (paymentRequirements.asset !== asset) {
    throw new Error("payment requirements use an unexpected asset");
  }
}

function validatePreparedQuote(paymentRequirements, prepared) {
  if (!prepared || typeof prepared !== "object") {
    throw new Error("quote builder did not return a quote object");
  }

  if (prepared.signingSummary?.merchantAddress !== paymentRequirements.payTo) {
    throw new Error("quote merchant output address mismatch");
  }

  if (String(prepared.signingSummary?.transferAmountSompi) !== paymentRequirements.amount) {
    throw new Error("quote merchant output amount mismatch");
  }

  if (prepared.signingSummary?.feeSompi > getKaspaMaxFeeSompi(paymentRequirements)) {
    throw new Error("quote fee exceeds the payment requirement max fee");
  }
}

export class FacilitatorService {
  constructor({
    facilitatorUrl = FACILITATOR_URL,
    network = DEFAULT_NETWORK,
    asset = DEFAULT_ASSET,
    quoteBuilder = unsupportedQuoteBuilder,
    paymentPayloadVerifier,
    paymentSettler = unsupportedPaymentSettler,
    stateFile = process.env.X402_FACILITATOR_STATE_FILE ?? DEFAULT_STATE_FILE
  } = {}) {
    if (typeof quoteBuilder !== "function") {
      throw new Error("quoteBuilder is required");
    }

    if (paymentPayloadVerifier != null && typeof paymentPayloadVerifier !== "function") {
      throw new Error("paymentPayloadVerifier must be a function");
    }

    if (typeof paymentSettler !== "function") {
      throw new Error("paymentSettler is required");
    }

    this.facilitatorUrl = facilitatorUrl;
    this.network = network;
    this.asset = asset;
    this.quoteBuilder = quoteBuilder;
    this.paymentPayloadVerifier = paymentPayloadVerifier;
    this.paymentSettler = paymentSettler;
    this.stateFile = stateFile;
    this.quotes = new Map();
    this.payments = loadPayments(stateFile);
  }

  async createPreparation({ paymentRequirements, payerAddress, payerAddresses }) {
    validateSupportedPaymentRequirements(this, paymentRequirements);

    const payerAddressList = Array.isArray(payerAddresses)
      ? payerAddresses.filter((value) => typeof value === "string" && value)
      : [];
    if (payerAddress && typeof payerAddress === "string" && !payerAddressList.includes(payerAddress)) {
      payerAddressList.unshift(payerAddress);
    }
    if (payerAddressList.length === 0) {
      throw new Error("payerAddress or payerAddresses is required");
    }

    const prepared = await this.quoteBuilder({
      paymentRequirements,
      payerAddress,
      payerAddresses: payerAddressList
    });

    validatePreparedQuote(paymentRequirements, prepared);

    const quote = {
      x402Version: X402_VERSION,
      scheme: SCHEME_NAME,
      txFormat: getKaspaTxFormat(paymentRequirements),
      quoteId: createId("quote"),
      paymentRequirements,
      unsignedTransaction: prepared.unsignedTransaction,
      signingSummary: prepared.signingSummary,
      payerContext: {
        payerAddress: prepared.payerAddress
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + paymentRequirements.maxTimeoutSeconds * 1000).toISOString()
    };

    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  async verifyPayment(request) {
    assertVerifyRequest(request);
    validateSupportedPaymentRequirements(this, request.paymentRequirements);

    if (!samePaymentRequirements(request.paymentPayload.accepted, request.paymentRequirements)) {
      return {
        isValid: false,
        invalidReason: "accepted_payment_requirements_mismatch"
      };
    }

    const quoteId = request.paymentPayload.payload?.quoteId;
    if (typeof quoteId !== "string" || !quoteId) {
      return {
        isValid: false,
        invalidReason: "missing_quote_id"
      };
    }

    const transaction = request.paymentPayload.payload?.transaction;
    if (typeof transaction !== "string" || !transaction) {
      return {
        isValid: false,
        invalidReason: "missing_transaction"
      };
    }

    const txFormat = request.paymentPayload.payload?.txFormat ?? getKaspaTxFormat(request.paymentRequirements);
    if (txFormat !== REAL_TX_FORMAT) {
      return {
        isValid: false,
        invalidReason: "unsupported_tx_format"
      };
    }

    const quote = this.quotes.get(quoteId);
    if (!quote) {
      return {
        isValid: false,
        invalidReason: "unknown_quote_id"
      };
    }

    if (Date.now() >= Date.parse(quote.expiresAt)) {
      return {
        isValid: false,
        invalidReason: "quote_expired"
      };
    }

    if (!samePaymentRequirements(quote.paymentRequirements, request.paymentRequirements)) {
      return {
        isValid: false,
        invalidReason: "quote_payment_requirements_mismatch"
      };
    }

    if (!this.paymentPayloadVerifier) {
      return {
        isValid: true,
        payer: quote.payerContext.payerAddress
      };
    }

    const verification = await this.paymentPayloadVerifier({
      paymentPayload: request.paymentPayload,
      paymentRequirements: request.paymentRequirements,
      quote
    });

    if (!verification || typeof verification !== "object") {
      throw new Error("paymentPayloadVerifier must return an object");
    }

    return {
      isValid: verification.isValid !== false,
      payer: verification.payer ?? quote.payerContext.payerAddress,
      ...(verification.isValid === false && verification.invalidReason
        ? { invalidReason: verification.invalidReason }
        : {})
    };
  }

  async settlePayment(request) {
    const verification = await this.verifyPayment(request);
    if (!verification.isValid) {
      return createSettlementResponse({
        success: false,
        transaction: "",
        network: this.network,
        payer: verification.payer,
        errorReason: verification.invalidReason ?? "invalid_payment"
      });
    }

    const quote = this.quotes.get(request.paymentPayload.payload.quoteId);
    const paymentId = getPaymentIdFromExtensions(request.paymentPayload.extensions) ?? createId("payment");
    const existing = this.payments.get(paymentId);
    if (existing) {
      return existing.settlementResponse;
    }

    const settlement = await this.paymentSettler({
      paymentPayload: request.paymentPayload,
      paymentRequirements: request.paymentRequirements,
      quote,
      paymentId
    });

    const settlementResponse = createSettlementResponse({
      success: settlement.success !== false,
      transaction: settlement.transaction ?? "",
      network: settlement.network ?? this.network,
      payer: settlement.payer ?? verification.payer,
      errorReason: settlement.success === false ? settlement.errorReason ?? "settlement_failed" : undefined,
      extensions: request.paymentPayload.extensions
    });

    if (settlementResponse.success) {
      const payment = {
        status: "accepted",
        paymentId,
        payer: settlementResponse.payer ?? null,
        paymentPayload: request.paymentPayload,
        paymentRequirements: request.paymentRequirements,
        settlementResponse,
        acceptedAt: new Date().toISOString()
      };
      this.payments.set(paymentId, payment);
      persistPayments(this.stateFile, this.payments);
    }

    return settlementResponse;
  }

  getPayment(paymentId) {
    return this.payments.get(paymentId) ?? {
      status: "pending",
      paymentId
    };
  }

  getSupported() {
    return createSupportedResponse({
      network: this.network,
      asset: this.asset
    });
  }

  getHealth() {
    return {
      ok: true,
      x402Version: X402_VERSION,
      scheme: SCHEME_NAME,
      network: this.network,
      asset: this.asset,
      facilitatorUrl: this.facilitatorUrl
    };
  }
}
