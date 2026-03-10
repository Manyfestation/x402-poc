import assert from "node:assert/strict";
import { verifyTransactionQuoteForPayer } from "@x402-kaspa/kaspa-core";
import {
  DEFAULT_PAYER_MNEMONIC,
  deriveAddressCandidatesFromMnemonic,
  deriveAddressFromMnemonic,
  getHttpTimeoutMs,
  signUnsignedTransaction
} from "@x402-kaspa/kaspa-wasm";
import {
  JSON_CONTENT_TYPE,
  encodeReceiptHeader
} from "@x402-kaspa/protocol";
import {
  FACILITATOR_URL,
  MERCHANT_URL
} from "@x402-kaspa/test-kit";

const HTTP_TIMEOUT_MS = getHttpTimeoutMs();

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: options.signal ?? AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? `request failed with ${response.status} for ${url}`);
  }

  return payload;
}

async function waitForJson(url, label) {
  let lastError;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`${label} is not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForMerchantChallenge() {
  let lastError;

  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(`${MERCHANT_URL}/premium`, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
      });
      const payload = await readJson(response);
      if (response.status !== 402) {
        throw new Error(`merchant returned ${response.status}`);
      }

      return { response, payload };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  throw new Error(`merchant is not ready: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function main() {
  await waitForJson(`${FACILITATOR_URL}/health`, "facilitator");

  const { response: firstResponse, payload: challenge } = await waitForMerchantChallenge();

  const requirement = challenge.requirement;
  const walletStatus = await deriveAddressFromMnemonic({
    mnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC,
    network: requirement.network
  });
  const walletCandidates = await deriveAddressCandidatesFromMnemonic({
    mnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC,
    network: requirement.network
  });
  const quote = await fetchJson(`${FACILITATOR_URL}/quotes`, {
    method: "POST",
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    body: JSON.stringify({
      requirement,
      payerAddress: walletStatus.address,
      payerAddresses: walletCandidates.addresses
    })
  });

  verifyTransactionQuoteForPayer({
    quote,
    requirement,
    payerAddresses: walletCandidates.addresses
  });

  const signed = await signUnsignedTransaction({
    unsignedTransaction: quote.unsignedTransaction,
    mnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC,
    network: requirement.network
  });

  const receipt = await fetchJson(`${FACILITATOR_URL}/submit`, {
    method: "POST",
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    body: JSON.stringify({
      quoteId: quote.quoteId,
      signedTransaction: signed.signedTransaction
    })
  });
  assert.match(receipt.txid, /^[0-9a-f]{64}$/i, "facilitator did not return a real txid");
  const payment = {
    txid: receipt.txid,
    payerAddress: signed.payerAddress
  };

  const retryResponse = await fetch(`${MERCHANT_URL}/premium`, {
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    headers: {
      "x-payment-receipt": encodeReceiptHeader(receipt)
    }
  });
  const retryBody = await retryResponse.text();
  assert.equal(retryResponse.status, 200, "merchant did not unlock after receipt verification");

  const facilitatorPayment = await fetchJson(`${FACILITATOR_URL}/payments/${encodeURIComponent(receipt.paymentId)}`);
  assert.equal(facilitatorPayment.status, "accepted", "facilitator state is not accepted");
  assert.equal(facilitatorPayment.receipt.txid, payment.txid, "facilitator state txid mismatch");

  const explorerUrl = `https://tn12.kaspa.stream/transactions/${payment.txid}`;
  const explorerResponse = await fetch(explorerUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  const explorerBody = await explorerResponse.text();
  assert.ok(explorerResponse.ok, "explorer URL did not resolve");
  assert.ok(
    explorerResponse.url.includes(payment.txid) || explorerBody.includes(payment.txid),
    "explorer response did not include the transaction id"
  );

  console.log(JSON.stringify({
    firstStatus: firstResponse.status,
    finalStatus: retryResponse.status,
    txid: payment.txid,
    receipt,
    retryBody,
    explorerUrl
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
