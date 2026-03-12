import { readFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PAYER_MNEMONIC,
  deriveAddressFromMnemonic,
  getKaspaBrowserSdkDir,
  getKaspaSdkFlavor,
  getHttpTimeoutMs,
  toKaspaNetworkId
} from "@x402-kaspa/kaspa-wasm";
import {
  JSON_CONTENT_TYPE,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER
} from "@x402-kaspa/protocol";
import {
  FACILITATOR_URL,
  MERCHANT_URL
} from "@x402-kaspa/test-kit";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, "../public");
const kaspaBrowserSdkDir = getKaspaBrowserSdkDir();
const port = 4023;
const httpTimeoutMs = getHttpTimeoutMs();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8"
};

function send(response, statusCode, body, contentType, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "content-type": contentType,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,payment-signature,payment-required,payment-response",
    "access-control-expose-headers": "payment-signature,payment-required,payment-response",
    ...extraHeaders
  });
  response.end(body);
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function forwardJson({ method, url, body, headers = {} }) {
  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(httpTimeoutMs)
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  return {
    status: response.status,
    payload
  };
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host ?? "127.0.0.1"}`);

    if (request.method === "OPTIONS") {
      return send(response, 204, "", "text/plain; charset=utf-8");
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      const wallet = await deriveAddressFromMnemonic({
        mnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC,
        network: "kaspa:testnet-12"
      });
      return send(
        response,
        200,
        JSON.stringify(
          {
            merchantUrl: MERCHANT_URL,
            facilitatorUrl: FACILITATOR_URL,
            payerAddress: wallet.address,
            networkId: toKaspaNetworkId("kaspa:testnet-12"),
            explorerBaseUrl: "https://tn12.kaspa.stream/transactions/",
            httpTimeoutMs,
            sdkFlavor: getKaspaSdkFlavor()
          },
          null,
          2
        ),
        JSON_CONTENT_TYPE
      );
    }

    if (request.method === "GET" && url.pathname === "/api/wallet-session") {
      return send(
        response,
        200,
        JSON.stringify(
          {
            mnemonic: process.env.X402_PAYER_MNEMONIC ?? DEFAULT_PAYER_MNEMONIC
          },
          null,
          2
        ),
        JSON_CONTENT_TYPE
      );
    }

    if (request.method === "GET" && url.pathname === "/api/merchant/premium") {
      const paymentSignatureHeader = request.headers[PAYMENT_SIGNATURE_HEADER];
      const merchantResponse = await fetch(`${MERCHANT_URL}/premium`, {
        signal: AbortSignal.timeout(httpTimeoutMs),
        headers: paymentSignatureHeader ? { [PAYMENT_SIGNATURE_HEADER]: paymentSignatureHeader } : {}
      });
      const text = await merchantResponse.text();
      const contentType = merchantResponse.headers.get("content-type") ?? "text/plain; charset=utf-8";
      const forwardedHeaders = {};
      const paymentRequiredHeader = merchantResponse.headers.get(PAYMENT_REQUIRED_HEADER);
      if (paymentRequiredHeader) {
        forwardedHeaders[PAYMENT_REQUIRED_HEADER] = paymentRequiredHeader;
      }
      const paymentResponseHeader = merchantResponse.headers.get(PAYMENT_RESPONSE_HEADER);
      if (paymentResponseHeader) {
        forwardedHeaders[PAYMENT_RESPONSE_HEADER] = paymentResponseHeader;
      }
      return send(response, merchantResponse.status, text, contentType, forwardedHeaders);
    }

    if (request.method === "POST" && url.pathname === "/api/facilitator/prepare") {
      const body = await readJsonBody(request);
      const result = await forwardJson({
        method: "POST",
        url: `${FACILITATOR_URL}/v2/x402/prepare`,
        body,
        headers: {
          "content-type": "application/json"
        }
      });
      return send(response, result.status, JSON.stringify(result.payload, null, 2), JSON_CONTENT_TYPE);
    }

    if (request.method === "GET" && url.pathname.startsWith("/vendor/kaspa/")) {
      const relativePath = url.pathname.slice("/vendor/kaspa/".length);
      const filePath = path.join(kaspaBrowserSdkDir, relativePath);
      const ext = path.extname(filePath);
      const contentType = mimeTypes[ext] ?? "application/octet-stream";
      const file = await readFile(filePath);
      return send(response, 200, file, contentType);
    }

    const filePath = url.pathname === "/" ? path.join(publicDir, "index.html") : path.join(publicDir, url.pathname);
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] ?? "application/octet-stream";
    const file = await readFile(filePath);
    return send(response, 200, file, contentType);
  } catch (error) {
    return send(
      response,
      500,
      JSON.stringify({ error: error instanceof Error ? error.message : "not found" }, null, 2),
      JSON_CONTENT_TYPE
    );
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`web ui listening on http://127.0.0.1:${port}`);
});
