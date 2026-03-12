import http from "node:http";
import {
  DEFAULT_MERCHANT_MNEMONIC,
  deriveAddressFromMnemonic
} from "@x402-kaspa/kaspa-wasm";
import {
  JSON_CONTENT_TYPE,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createSettlementResponse,
  createVerifyRequest,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
  samePaymentRequirements
} from "@x402-kaspa/protocol";
import {
  FACILITATOR_URL,
  MERCHANT_PORT,
  PREMIUM_RESOURCE_PATH,
  buildDemoPaymentRequired
} from "@x402-kaspa/test-kit";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-allow-headers": "content-type,payment-signature,payment-required,payment-response",
  "access-control-expose-headers": "payment-signature,payment-required,payment-response"
};

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": JSON_CONTENT_TYPE,
    ...CORS_HEADERS,
    ...extraHeaders
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, body, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": "text/plain; charset=utf-8",
    ...CORS_HEADERS,
    ...extraHeaders
  });
  response.end(body);
}

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function postFacilitator(pathname, body) {
  const response = await fetch(`${FACILITATOR_URL}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    body: JSON.stringify(body)
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? `facilitator request failed with ${response.status}`);
  }

  return payload;
}

function getResourceInfo() {
  return {
    url: `http://127.0.0.1:${MERCHANT_PORT}${PREMIUM_RESOURCE_PATH}`,
    description: "Kaspa x402 premium content",
    mimeType: "text/plain; charset=utf-8"
  };
}

function sameResource(left, right) {
  return left?.url === right?.url && left?.description === right?.description && left?.mimeType === right?.mimeType;
}

function buildMerchantChallenge(merchantAddress) {
  return buildDemoPaymentRequired({
    merchantAddress,
    resourceUrl: getResourceInfo().url,
    resourceDescription: getResourceInfo().description,
    resourceMimeType: getResourceInfo().mimeType
  });
}

function buildFailedSettlementResponse(paymentPayload, paymentRequirements, verification) {
  return createSettlementResponse({
    success: false,
    transaction: "",
    network: paymentRequirements.network,
    payer: verification.payer,
    errorReason: verification.invalidReason ?? "invalid_payment",
    extensions: paymentPayload.extensions
  });
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
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }

    if (request.method !== "GET" || request.url !== PREMIUM_RESOURCE_PATH) {
      return sendJson(response, 404, { error: "not found" });
    }

    const merchantAddress = await merchantAddressPromise;
    const paymentRequired = buildMerchantChallenge(merchantAddress);
    const expectedPaymentRequirements = paymentRequired.accepts[0];
    const paymentSignatureHeader = request.headers[PAYMENT_SIGNATURE_HEADER];

    if (!paymentSignatureHeader) {
      return sendJson(
        response,
        402,
        { error: "payment required" },
        {
          [PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(paymentRequired)
        }
      );
    }

    let paymentPayload;
    try {
      paymentPayload = decodePaymentSignatureHeader(paymentSignatureHeader);
    } catch (error) {
      return sendJson(response, 400, {
        error: error instanceof Error ? error.message : "invalid payment payload"
      });
    }

    if (!sameResource(paymentPayload.resource, paymentRequired.resource)) {
      return sendJson(response, 400, {
        error: "payment payload resource does not match the protected resource"
      });
    }

    if (!samePaymentRequirements(paymentPayload.accepted, expectedPaymentRequirements)) {
      return sendJson(response, 400, {
        error: "payment payload accepted requirements do not match the merchant challenge"
      });
    }

    const verifyRequest = createVerifyRequest({
      paymentPayload,
      paymentRequirements: expectedPaymentRequirements
    });
    const verification = await postFacilitator("/v2/x402/verify", verifyRequest);

    if (!verification.isValid) {
      const settlementResponse = buildFailedSettlementResponse(paymentPayload, expectedPaymentRequirements, verification);
      return sendJson(
        response,
        402,
        { error: verification.invalidReason ?? "payment verification failed" },
        {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlementResponse)
        }
      );
    }

    const settlementResponse = await postFacilitator("/v2/x402/settle", verifyRequest);
    if (!settlementResponse.success) {
      return sendJson(
        response,
        402,
        { error: settlementResponse.errorReason ?? "payment settlement failed" },
        {
          [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlementResponse)
        }
      );
    }

    return sendText(
      response,
      200,
      "premium content unlocked",
      {
        [PAYMENT_RESPONSE_HEADER]: encodePaymentResponseHeader(settlementResponse)
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
