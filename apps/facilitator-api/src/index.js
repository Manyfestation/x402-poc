import http from "node:http";
import { JSON_CONTENT_TYPE } from "@x402-kaspa/protocol";
import { FACILITATOR_PORT } from "@x402-kaspa/test-kit";
import { FacilitatorService } from "./service.js";

const service = new FacilitatorService();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": JSON_CONTENT_TYPE,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,x-payment-receipt"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
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

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET,POST,OPTIONS",
        "access-control-allow-headers": "content-type,x-payment-receipt"
      });
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, service.getHealth());
    }

    if (request.method === "POST" && url.pathname === "/quotes") {
      const body = await readJsonBody(request);
      const quote = await service.createQuote(body);
      return sendJson(response, 200, quote);
    }

    if (request.method === "POST" && url.pathname === "/submit") {
      const body = await readJsonBody(request);
      const receipt = await service.submitQuote(body);
      return sendJson(response, 200, receipt);
    }

    if (request.method === "GET" && url.pathname.startsWith("/payments/")) {
      const paymentId = decodeURIComponent(url.pathname.slice("/payments/".length));
      return sendJson(response, 200, service.getPayment(paymentId));
    }

    return sendError(response, 404, "not found");
  } catch (error) {
    return sendError(response, 400, error instanceof Error ? error.message : "unexpected facilitator error");
  }
});

server.listen(FACILITATOR_PORT, "127.0.0.1", () => {
  console.log(`facilitator listening on http://127.0.0.1:${FACILITATOR_PORT}`);
});
