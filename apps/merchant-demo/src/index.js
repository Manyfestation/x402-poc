import http from "node:http";
import {
  DEFAULT_MERCHANT_MNEMONIC,
  deriveAddressFromMnemonic
} from "@x402-kaspa/kaspa-wasm";
import {
  JSON_CONTENT_TYPE,
  SCHEME_NAME,
  decodeReceiptHeader
} from "@x402-kaspa/protocol";
import {
  FACILITATOR_URL,
  MERCHANT_PORT,
  buildDemoRequirement
} from "@x402-kaspa/test-kit";

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": JSON_CONTENT_TYPE,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type,x-payment-receipt",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,OPTIONS",
    "access-control-allow-headers": "content-type,x-payment-receipt"
  });
  response.end(body);
}

async function verifyReceipt(receipt) {
  if (!receipt || typeof receipt !== "object" || receipt.scheme !== SCHEME_NAME) {
    return false;
  }

  const response = await fetch(`${FACILITATOR_URL}/payments/${encodeURIComponent(receipt.paymentId)}`);
  if (!response.ok) {
    return false;
  }

  const payment = await response.json();
  return (
    payment.status === "accepted" &&
    payment.receipt.scheme === receipt.scheme &&
    payment.receipt.quoteId === receipt.quoteId &&
    payment.receipt.paymentId === receipt.paymentId &&
    payment.receipt.txid === receipt.txid &&
    payment.receipt.amountSompi === receipt.amountSompi &&
    payment.receipt.merchantAddress === receipt.merchantAddress &&
    payment.receipt.status === "accepted"
  );
}

const merchantAddressPromise = process.env.X402_MERCHANT_ADDRESS
  ? Promise.resolve(process.env.X402_MERCHANT_ADDRESS)
  : deriveAddressFromMnemonic({
      mnemonic: DEFAULT_MERCHANT_MNEMONIC,
      network: "kaspa:testnet-12"
    }).then((wallet) => wallet.address);

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,OPTIONS",
        "access-control-allow-headers": "content-type,x-payment-receipt"
      });
      response.end();
      return;
    }

    if (request.method !== "GET" || request.url !== "/premium") {
      return sendJson(response, 404, { error: "not found" });
    }

    const receiptHeader = request.headers["x-payment-receipt"];
    if (receiptHeader) {
      try {
        const receipt = decodeReceiptHeader(receiptHeader);
        if (await verifyReceipt(receipt)) {
          return sendText(response, 200, "premium content unlocked");
        }
      } catch {
        // Fall through to the paywall when the receipt header is malformed.
      }
    }

    const requirement = buildDemoRequirement({
      merchantAddress: await merchantAddressPromise
    });
    return sendJson(
      response,
      402,
      {
        error: "payment required",
        requirement
      },
      {
        "x-payment-scheme": requirement.scheme
      }
    );
  } catch (error) {
    return sendJson(response, 400, {
      error: error instanceof Error ? error.message : "unexpected merchant error"
    });
  }
});

server.listen(MERCHANT_PORT, "127.0.0.1", () => {
  console.log(`merchant listening on http://127.0.0.1:${MERCHANT_PORT}`);
});
