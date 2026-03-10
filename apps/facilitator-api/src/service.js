import {
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_NETWORK,
  REAL_TX_FORMAT,
  SCHEME_NAME,
  assertPaymentRequirement,
  createId
} from "@x402-kaspa/protocol";
import {
  FACILITATOR_URL
} from "@x402-kaspa/test-kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_STATE_FILE = path.resolve(__dirname, "../.data/facilitator-state.json");

async function unsupportedQuoteBuilder() {
  throw new Error("the active TN12 facilitator runtime is the Rust service behind `npm run facilitator`");
}

async function unsupportedPaymentVerifier() {
  throw new Error("the active TN12 facilitator runtime is the Rust service behind `npm run facilitator`");
}

function loadPayments(stateFile) {
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    const payments = Array.isArray(parsed.payments) ? parsed.payments : [];
    return new Map(payments.map((payment) => [payment.paymentId ?? payment.receipt?.paymentId, payment]));
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

export class FacilitatorService {
  constructor({
    facilitatorUrl = FACILITATOR_URL,
    network = DEFAULT_NETWORK,
    quoteBuilder = unsupportedQuoteBuilder,
    paymentVerifier = unsupportedPaymentVerifier,
    stateFile = process.env.X402_FACILITATOR_STATE_FILE ?? DEFAULT_STATE_FILE
  } = {}) {
    if (typeof quoteBuilder !== "function") {
      throw new Error("quoteBuilder is required");
    }

    if (typeof paymentVerifier !== "function") {
      throw new Error("paymentVerifier is required");
    }

    this.facilitatorUrl = facilitatorUrl;
    this.network = network;
    this.quoteBuilder = quoteBuilder;
    this.paymentVerifier = paymentVerifier;
    this.stateFile = stateFile;
    this.quotes = new Map();
    this.payments = loadPayments(stateFile);
  }

  async createQuote({ requirement, payerAddress }) {
    assertPaymentRequirement(requirement);

    if (requirement.facilitatorUrl !== this.facilitatorUrl) {
      throw new Error("payment requirement points to a different facilitator");
    }

    if (requirement.network !== this.network) {
      throw new Error("payment requirement uses an unexpected network");
    }

    if (Date.now() >= Date.parse(requirement.expiresAt)) {
      throw new Error("payment requirement has expired");
    }

    if (!payerAddress || typeof payerAddress !== "string") {
      throw new Error("payerAddress is required");
    }

    const prepared = await this.quoteBuilder({
      requirement,
      payerAddress
    });

    if (prepared.signingSummary.merchantAddress !== requirement.merchantAddress) {
      throw new Error("quote merchant output address mismatch");
    }

    if (prepared.signingSummary.transferAmountSompi !== requirement.amountSompi) {
      throw new Error("quote merchant output amount mismatch");
    }

    if (prepared.signingSummary.feeSompi > requirement.maxFeeSompi) {
      throw new Error("quote fee exceeds the payment requirement max fee");
    }

    const quote = {
      scheme: SCHEME_NAME,
      txFormat: REAL_TX_FORMAT,
      quoteId: createId("quote"),
      requirement,
      unsignedTransaction: prepared.unsignedTransaction,
      signingSummary: prepared.signingSummary,
      payerContext: {
        payerAddress: prepared.payerAddress
      },
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Math.min(Date.parse(requirement.expiresAt), Date.now() + 5 * 60_000)).toISOString()
    };

    this.quotes.set(quote.quoteId, quote);
    return quote;
  }

  async submitQuote({ quoteId, txid }) {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      throw new Error("unknown quote id");
    }

    if (Date.now() >= Date.parse(quote.expiresAt)) {
      throw new Error("quote has expired");
    }

    if (!txid || typeof txid !== "string") {
      throw new Error("missing txid");
    }

    const verification = await this.paymentVerifier({
      txid,
      merchantAddress: quote.requirement.merchantAddress,
      amountSompi: quote.requirement.amountSompi,
      network: quote.requirement.network
    });

    if (!verification.accepted) {
      throw new Error("facilitator could not verify the merchant output on TN12");
    }

    const receipt = {
      scheme: SCHEME_NAME,
      paymentId: quote.requirement.paymentId,
      quoteId: quote.quoteId,
      txid,
      payerAddress: quote.payerContext.payerAddress,
      merchantAddress: quote.requirement.merchantAddress,
      amountSompi: quote.requirement.amountSompi,
      feeSompi: quote.signingSummary.feeSompi,
      status: "accepted",
      acceptedAt: new Date().toISOString()
    };

    const payment = {
      status: "accepted",
      paymentId: receipt.paymentId,
      requirement: quote.requirement,
      receipt
    };

    this.payments.set(receipt.paymentId, payment);
    persistPayments(this.stateFile, this.payments);

    return receipt;
  }

  getPayment(paymentId) {
    return this.payments.get(paymentId) ?? {
      status: "pending",
      paymentId
    };
  }

  getHealth() {
    return {
      ok: true,
      scheme: SCHEME_NAME,
      network: this.network,
      facilitatorUrl: this.facilitatorUrl
    };
  }
}
