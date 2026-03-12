import assert from "node:assert/strict";
import { DEFAULT_PAYER_MNEMONIC, getHttpTimeoutMs } from "@x402-kaspa/kaspa-wasm";
import { FACILITATOR_URL, MERCHANT_URL } from "@x402-kaspa/test-kit";
import { payProtectedResource } from "@x402-kaspa/x402-client";

const HTTP_TIMEOUT_MS = getHttpTimeoutMs();

async function main() {
  const result = await payProtectedResource({
    resourceUrl: `${MERCHANT_URL}/premium`,
    facilitatorUrl: FACILITATOR_URL,
    walletMnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC
  });

  assert.equal(result.finalStatus, 200, "merchant did not unlock after settlement");
  assert.equal(result.step, "completed", "payment flow did not complete");
  assert.equal(result.paymentRequirements.scheme, "exact", "merchant did not advertise the exact scheme");
  assert.match(
    result.settlementResponse?.transaction ?? "",
    /^[0-9a-f]{64}$/i,
    "facilitator did not return a real txid"
  );

  const explorerUrl = `https://tn12.kaspa.stream/transactions/${result.settlementResponse.transaction}`;
  const explorerResponse = await fetch(explorerUrl, {
    redirect: "follow",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  const explorerBody = await explorerResponse.text();
  assert.ok(explorerResponse.ok, "explorer URL did not resolve");
  assert.ok(
    explorerResponse.url.includes(result.settlementResponse.transaction) ||
      explorerBody.includes(result.settlementResponse.transaction),
    "explorer response did not include the transaction id"
  );

  console.log(JSON.stringify({
    finalStatus: result.finalStatus,
    paymentRequired: result.paymentRequired,
    paymentPayload: result.paymentPayload,
    settlementResponse: result.settlementResponse,
    finalBody: result.finalBody,
    explorerUrl
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
