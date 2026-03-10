import { DEFAULT_PAYER_MNEMONIC } from "@x402-kaspa/kaspa-wasm";
import { MERCHANT_URL } from "@x402-kaspa/test-kit";
import { payProtectedResource } from "@x402-kaspa/x402-client";

async function main() {
  const result = await payProtectedResource({
    resourceUrl: `${MERCHANT_URL}/premium`,
    walletMnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC
  });

  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
