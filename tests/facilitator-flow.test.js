import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { FacilitatorService } from "@x402-kaspa/facilitator-api";
import { buildDemoRequirement } from "@x402-kaspa/test-kit";

function createTempStateFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "x402-facilitator-test-"));
  return {
    dir,
    stateFile: path.join(dir, "facilitator-state.json")
  };
}

function buildPreparedQuote(requirement, overrides = {}) {
  return {
    network: "testnet-12",
    payerAddress: "kaspatest:qpayer000000000000000000000000000000000000000000000000000000",
    unsignedTransaction: JSON.stringify({ version: 0, inputs: [], outputs: [] }),
    signingSummary: {
      payerAddress: "kaspatest:qpayer000000000000000000000000000000000000000000000000000000",
      merchantAddress: requirement.merchantAddress,
      selectedInputs: [
        {
          outpoint: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef:0",
          address: "kaspatest:qpayer000000000000000000000000000000000000000000000000000000",
          amountSompi: 7_200
        }
      ],
      totalInputSompi: 7_200,
      transferAmountSompi: requirement.amountSompi,
      changeAddress: "kaspatest:qchange00000000000000000000000000000000000000000000000000000",
      changeAmountSompi: 1_700,
      feeSompi: 500,
      txCount: 1
    },
    ...overrides
  };
}

function createQuoteBuilder({ prepared, assertions }) {
  return async ({ requirement, payerAddress }) => {
    assertions?.push({
      type: "quote",
      requirement,
      payerAddress
    });
    return prepared;
  };
}

function createPaymentVerifier({ accepted = true, assertions }) {
  return async ({ txid, merchantAddress, amountSompi, network }) => {
    assertions?.push({
      type: "verify",
      txid,
      merchantAddress,
      amountSompi,
      network
    });
    return { accepted };
  };
}

test("facilitator stores a verified receipt on disk", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const requirement = buildDemoRequirement({
      paymentId: "pay_happy",
      merchantAddress: "kaspatest:qmerchant000000000000000000000000000000000000000000000000000"
    });
    const prepared = buildPreparedQuote(requirement);
    const assertions = [];
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared, assertions }),
      paymentVerifier: createPaymentVerifier({ assertions }),
      stateFile
    });

    const quote = await service.createQuote({
      requirement,
      payerAddress: prepared.payerAddress
    });
    const receipt = await service.submitQuote({
      quoteId: quote.quoteId,
      txid: "b".repeat(64)
    });
    const payment = service.getPayment(requirement.paymentId);
    const persisted = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentVerifier: createPaymentVerifier({}),
      stateFile
    });

    assert.equal(quote.txFormat, "kaspa-unsigned-transaction-v1");
    assert.equal(receipt.paymentId, requirement.paymentId);
    assert.equal(receipt.txid, "b".repeat(64));
    assert.equal(payment.status, "accepted");
    assert.equal(persisted.getPayment(requirement.paymentId).receipt.txid, "b".repeat(64));

    const written = JSON.parse(readFileSync(stateFile, "utf8"));
    assert.equal(written.payments.length, 1);
    assert.deepEqual(assertions, [
      {
        type: "quote",
        requirement,
        payerAddress: prepared.payerAddress
      },
      {
        type: "verify",
        txid: "b".repeat(64),
        merchantAddress: requirement.merchantAddress,
        amountSompi: requirement.amountSompi,
        network: requirement.network
      }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote creation rejects a quote summary with the wrong merchant output", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const requirement = buildDemoRequirement({
      paymentId: "pay_bad_merchant",
      merchantAddress: "kaspatest:qmerchant000000000000000000000000000000000000000000000000000"
    });
    const prepared = buildPreparedQuote(requirement, {
      signingSummary: {
        ...buildPreparedQuote(requirement).signingSummary,
        merchantAddress: "kaspatest:qothermerchant00000000000000000000000000000000000000000000000"
      }
    });
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentVerifier: createPaymentVerifier({}),
      stateFile
    });

    await assert.rejects(
      () => service.createQuote({ requirement, payerAddress: prepared.payerAddress }),
      /merchant output address mismatch/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote creation rejects fees above the requirement max", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const requirement = buildDemoRequirement({
      paymentId: "pay_fee_cap",
      maxFeeSompi: 100
    });
    const prepared = buildPreparedQuote(requirement, {
      signingSummary: {
        ...buildPreparedQuote(requirement).signingSummary,
        changeAmountSompi: 2_100,
        feeSompi: 600,
        totalInputSompi: 7_700
      }
    });
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentVerifier: createPaymentVerifier({}),
      stateFile
    });

    await assert.rejects(
      () => service.createQuote({ requirement, payerAddress: prepared.payerAddress }),
      /exceeds the payment requirement max fee/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("submitQuote rejects a txid the facilitator cannot verify on TN12", async () => {
  const { dir, stateFile } = createTempStateFile();
  try {
    const requirement = buildDemoRequirement({
      paymentId: "pay_unverified"
    });
    const prepared = buildPreparedQuote(requirement);
    const service = new FacilitatorService({
      quoteBuilder: createQuoteBuilder({ prepared }),
      paymentVerifier: createPaymentVerifier({ accepted: false }),
      stateFile
    });

    const quote = await service.createQuote({
      requirement,
      payerAddress: prepared.payerAddress
    });

    await assert.rejects(
      () => service.submitQuote({ quoteId: quote.quoteId, txid: "c".repeat(64) }),
      /could not verify the merchant output on TN12/
    );
    assert.deepEqual(service.getPayment(requirement.paymentId), {
      status: "pending",
      paymentId: requirement.paymentId
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
