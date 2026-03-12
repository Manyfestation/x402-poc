import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FacilitatorService } from "@x402-kaspa/facilitator-api";
import {
  X402_VERSION,
  createPaymentPayload
} from "@x402-kaspa/protocol";
import { buildDemoPaymentRequirements } from "@x402-kaspa/test-kit";

function createTempStateFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-facilitator-test-"));
  return {
    dir,
    stateFile: path.join(dir, "facilitator-state.json")
  };
}

function buildPreparedQuote(paymentRequirements, overrides = {}) {
  return {
    network: "testnet-12",
    payerAddress: "kaspatest:qpayer000000000000000000000000000000000000000000000000000000",
    unsignedTransaction: JSON.stringify({ version: 0, inputs: [], outputs: [] }),
    signingSummary: {
      payerAddress: "kaspatest:qpayer000000000000000000000000000000000000000000000000000000",
      merchantAddress: paymentRequirements.payTo,
      selectedInputs: [
        {
          outpoint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:0",
          address: "kaspatest:qpayer000000000000000000000000000000000000000000000000000000",
          amountSompi: 7_200
        }
      ],
      totalInputSompi: 7_200,
      transferAmountSompi: Number(paymentRequirements.amount),
      changeAddress: "kaspatest:qchange00000000000000000000000000000000000000000000000000000",
      changeAmountSompi: 1_700,
      feeSompi: 500,
      txCount: 1
    },
    ...overrides
  };
}

function createQuoteBuilder({ prepared, assertions }) {
  return async ({ paymentRequirements, payerAddress, payerAddresses }) => {
    assertions?.push({
      type: "prepare",
      paymentRequirements,
      payerAddress,
      payerAddresses
    });
    return prepared;
  };
}

function createPaymentPayloadVerifier({ isValid = true, assertions }) {
  return async ({ paymentPayload, paymentRequirements, quote }) => {
    assertions?.push({
      type: "verify",
      paymentRequirements,
      quoteId: quote.quoteId,
      paymentId: paymentPayload.extensions?.["payment-identifier"]?.info?.paymentId
    });
    return {
      isValid,
      payer: quote.payerContext.payerAddress,
      ...(isValid ? {} : { invalidReason: "invalid_signed_transaction" })
    };
  };
}

function createPaymentSettler({ success = true, assertions }) {
  return async ({ paymentPayload, paymentRequirements, quote, paymentId }) => {
    assertions?.push({
      type: "settle",
      paymentRequirements,
      quoteId: quote.quoteId,
      paymentId
    });
    return {
      success,
      payer: quote.payerContext.payerAddress,
      transaction: success ? "b".repeat(64) : "",
      network: paymentRequirements.network,
      ...(success ? {} : { errorReason: "settlement_failed" })
    };
  };
}

function buildPaymentPayload(paymentRequirements, quote, paymentId = "payment_happy") {
  return createPaymentPayload({
    resource: {
      url: "http://127.0.0.1:4022/premium",
      description: "Kaspa x402 premium content",
      mimeType: "text/plain; charset=utf-8"
    },
    accepted: paymentRequirements,
    quoteId: quote.quoteId,
    transaction: "PSKB_SIGNED_EXAMPLE",
    paymentId
  });
}

test("facilitator stores a settled x402 payment on disk", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const paymentRequirements = buildDemoPaymentRequirements({
      merchantAddress: "kaspatest:qmerchant000000000000000000000000000000000000000000000000000"
    });
    const prepared = buildPreparedQuote(paymentRequirements);
    const assertions = [];
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared, assertions }),
      paymentPayloadVerifier: createPaymentPayloadVerifier({ assertions }),
      paymentSettler: createPaymentSettler({ assertions }),
      stateFile
    });

    const quote = await service.createPreparation({
      paymentRequirements,
      payerAddress: prepared.payerAddress
    });
    const paymentPayload = buildPaymentPayload(paymentRequirements, quote);
    const verification = await service.verifyPayment({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements
    });
    const settlementResponse = await service.settlePayment({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements
    });
    const payment = service.getPayment("payment_happy");
    const persisted = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentPayloadVerifier: createPaymentPayloadVerifier({}),
      paymentSettler: createPaymentSettler({}),
      stateFile
    });

    assert.equal(quote.txFormat, "kaspa-unsigned-transaction-v1");
    assert.equal(verification.isValid, true);
    assert.equal(settlementResponse.success, true);
    assert.equal(settlementResponse.transaction, "b".repeat(64));
    assert.equal(payment.status, "accepted");
    assert.equal(persisted.getPayment("payment_happy").settlementResponse.transaction, "b".repeat(64));

    const written = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(written.payments.length, 1);
    assert.deepEqual(assertions, [
      {
        type: "prepare",
        paymentRequirements,
        payerAddress: prepared.payerAddress,
        payerAddresses: [prepared.payerAddress]
      },
      {
        type: "verify",
        paymentRequirements,
        quoteId: quote.quoteId,
        paymentId: "payment_happy"
      },
      {
        type: "verify",
        paymentRequirements,
        quoteId: quote.quoteId,
        paymentId: "payment_happy"
      },
      {
        type: "settle",
        paymentRequirements,
        quoteId: quote.quoteId,
        paymentId: "payment_happy"
      }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare rejects a quote summary with the wrong merchant output", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const paymentRequirements = buildDemoPaymentRequirements({
      merchantAddress: "kaspatest:qmerchant000000000000000000000000000000000000000000000000000"
    });
    const prepared = buildPreparedQuote(paymentRequirements, {
      signingSummary: {
        ...buildPreparedQuote(paymentRequirements).signingSummary,
        merchantAddress: "kaspatest:qothermerchant00000000000000000000000000000000000000000000000"
      }
    });
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentPayloadVerifier: createPaymentPayloadVerifier({}),
      paymentSettler: createPaymentSettler({}),
      stateFile
    });

    await assert.rejects(
      () => service.createPreparation({ paymentRequirements, payerAddress: prepared.payerAddress }),
      /merchant output address mismatch/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prepare rejects fees above the payment requirements max", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const paymentRequirements = buildDemoPaymentRequirements({
      maxFeeSompi: 100
    });
    const prepared = buildPreparedQuote(paymentRequirements, {
      signingSummary: {
        ...buildPreparedQuote(paymentRequirements).signingSummary,
        changeAmountSompi: 2_100,
        feeSompi: 600,
        totalInputSompi: 7_700
      }
    });
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentPayloadVerifier: createPaymentPayloadVerifier({}),
      paymentSettler: createPaymentSettler({}),
      stateFile
    });

    await assert.rejects(
      () => service.createPreparation({ paymentRequirements, payerAddress: prepared.payerAddress }),
      /exceeds the payment requirement max fee/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settlePayment returns a failed settlement response when verify rejects the payload", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const paymentRequirements = buildDemoPaymentRequirements();
    const prepared = buildPreparedQuote(paymentRequirements);
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentPayloadVerifier: createPaymentPayloadVerifier({ isValid: false }),
      paymentSettler: createPaymentSettler({}),
      stateFile
    });

    const quote = await service.createPreparation({
      paymentRequirements,
      payerAddress: prepared.payerAddress
    });
    const paymentPayload = buildPaymentPayload(paymentRequirements, quote, "payment_invalid");
    const settlementResponse = await service.settlePayment({
      x402Version: X402_VERSION,
      paymentPayload,
      paymentRequirements
    });

    assert.equal(settlementResponse.success, false);
    assert.equal(settlementResponse.errorReason, "invalid_signed_transaction");
    assert.deepEqual(service.getPayment("payment_invalid"), {
      status: "pending",
      paymentId: "payment_invalid"
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
