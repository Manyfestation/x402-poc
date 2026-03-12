import { createHash, randomUUID } from "node:crypto";

export const X402_VERSION = 2;
export const SCHEME_NAME = "exact";
export const DEFAULT_NETWORK = "kaspa:testnet-12";
export const DEFAULT_ASSET = "kaspa:testnet-12/slip44:111111";
export const TX_FORMAT = "kaspa-unsigned-transaction-v1";
export const REAL_TX_FORMAT = TX_FORMAT;
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "payment-signature";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

export const PAYMENT_IDENTIFIER_EXTENSION = "payment-identifier";

const PAYMENT_IDENTIFIER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    paymentId: {
      type: "string"
    }
  }
};

export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }

  return JSON.stringify(value);
}

export function sha256Hex(value) {
  const input = typeof value === "string" ? value : canonicalize(value);
  return createHash("sha256").update(input).digest("hex");
}

export function createId(prefix) {
  const compact = randomUUID().replace(/-/g, "");
  return `${prefix}_${compact}`;
}

function assertObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(message);
  }
}

function assertString(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

export function createPaymentIdentifierExtension(paymentId) {
  const info = {};
  if (paymentId) {
    info.paymentId = paymentId;
  }

  return {
    info,
    schema: PAYMENT_IDENTIFIER_SCHEMA
  };
}

export function withPaymentIdentifierExtension(extensions = {}, paymentId) {
  return {
    ...extensions,
    [PAYMENT_IDENTIFIER_EXTENSION]: createPaymentIdentifierExtension(paymentId)
  };
}

export function getPaymentIdFromExtensions(extensions) {
  return extensions?.[PAYMENT_IDENTIFIER_EXTENSION]?.info?.paymentId ?? null;
}

export function encodeX402Header(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeX402Header(headerValue) {
  const json = Buffer.from(headerValue, "base64").toString("utf8");
  return JSON.parse(json);
}

export function encodePaymentRequiredHeader(paymentRequired) {
  assertPaymentRequired(paymentRequired);
  return encodeX402Header(paymentRequired);
}

export function decodePaymentRequiredHeader(headerValue) {
  const paymentRequired = decodeX402Header(headerValue);
  assertPaymentRequired(paymentRequired);
  return paymentRequired;
}

export function encodePaymentSignatureHeader(paymentPayload) {
  assertPaymentPayload(paymentPayload);
  return encodeX402Header(paymentPayload);
}

export function decodePaymentSignatureHeader(headerValue) {
  const paymentPayload = decodeX402Header(headerValue);
  assertPaymentPayload(paymentPayload);
  return paymentPayload;
}

export function encodePaymentResponseHeader(settlementResponse) {
  assertSettlementResponse(settlementResponse);
  return encodeX402Header(settlementResponse);
}

export function decodePaymentResponseHeader(headerValue) {
  const settlementResponse = decodeX402Header(headerValue);
  assertSettlementResponse(settlementResponse);
  return settlementResponse;
}

export function assertResourceInfo(resource) {
  assertObject(resource, "resource must be an object");
  assertString(resource.url, "resource.url");
  if ("description" in resource && resource.description != null) {
    assertString(resource.description, "resource.description");
  }
  if ("mimeType" in resource && resource.mimeType != null) {
    assertString(resource.mimeType, "resource.mimeType");
  }
}

export function assertPaymentRequirements(requirement) {
  assertObject(requirement, "payment requirements must be an object");
  assertString(requirement.scheme, "scheme");
  assertString(requirement.network, "network");
  assertString(requirement.amount, "amount");
  assertString(requirement.asset, "asset");
  assertString(requirement.payTo, "payTo");
  assertPositiveInteger(requirement.maxTimeoutSeconds, "maxTimeoutSeconds");
  if ("extra" in requirement && requirement.extra != null) {
    assertObject(requirement.extra, "extra must be an object");
  }

  if (requirement.scheme !== SCHEME_NAME) {
    throw new Error(`unsupported scheme: ${requirement.scheme}`);
  }
}

export function assertPaymentRequired(paymentRequired) {
  assertObject(paymentRequired, "payment required must be an object");
  if (paymentRequired.x402Version !== X402_VERSION) {
    throw new Error(`x402Version must be ${X402_VERSION}`);
  }

  assertResourceInfo(paymentRequired.resource);
  if (!Array.isArray(paymentRequired.accepts) || paymentRequired.accepts.length === 0) {
    throw new Error("accepts must be a non-empty array");
  }

  for (const requirement of paymentRequired.accepts) {
    assertPaymentRequirements(requirement);
  }

  if ("extensions" in paymentRequired && paymentRequired.extensions != null) {
    assertObject(paymentRequired.extensions, "extensions must be an object");
  }
}

export function assertPaymentPayload(paymentPayload) {
  assertObject(paymentPayload, "payment payload must be an object");
  if (paymentPayload.x402Version !== X402_VERSION) {
    throw new Error(`x402Version must be ${X402_VERSION}`);
  }

  if ("resource" in paymentPayload && paymentPayload.resource != null) {
    assertResourceInfo(paymentPayload.resource);
  }

  assertPaymentRequirements(paymentPayload.accepted);
  assertObject(paymentPayload.payload, "payload must be an object");
  if ("extensions" in paymentPayload && paymentPayload.extensions != null) {
    assertObject(paymentPayload.extensions, "extensions must be an object");
  }
}

export function assertSettlementResponse(settlementResponse) {
  assertObject(settlementResponse, "settlement response must be an object");
  if (typeof settlementResponse.success !== "boolean") {
    throw new Error("success must be a boolean");
  }
  if (typeof settlementResponse.transaction !== "string") {
    throw new Error("transaction must be a string");
  }
  assertString(settlementResponse.network, "network");
  if ("payer" in settlementResponse && settlementResponse.payer != null) {
    assertString(settlementResponse.payer, "payer");
  }
  if (!settlementResponse.success && settlementResponse.errorReason != null) {
    assertString(settlementResponse.errorReason, "errorReason");
  }
  if ("extensions" in settlementResponse && settlementResponse.extensions != null) {
    assertObject(settlementResponse.extensions, "extensions must be an object");
  }
}

export function assertVerifyRequest(request) {
  assertObject(request, "verify request must be an object");
  if (request.x402Version !== X402_VERSION) {
    throw new Error(`x402Version must be ${X402_VERSION}`);
  }
  assertPaymentPayload(request.paymentPayload);
  assertPaymentRequirements(request.paymentRequirements);
}

export function assertVerifyResponse(response) {
  assertObject(response, "verify response must be an object");
  if (typeof response.isValid !== "boolean") {
    throw new Error("isValid must be a boolean");
  }
  if ("payer" in response && response.payer != null) {
    assertString(response.payer, "payer");
  }
  if (!response.isValid && response.invalidReason != null) {
    assertString(response.invalidReason, "invalidReason");
  }
}

export function samePaymentRequirements(left, right) {
  assertPaymentRequirements(left);
  assertPaymentRequirements(right);
  return canonicalize(left) === canonicalize(right);
}

export function getKaspaMaxFeeSompi(paymentRequirements) {
  const value = paymentRequirements?.extra?.maxFeeSompi;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("payment requirements extra.maxFeeSompi must be a non-negative integer");
  }
  return value;
}

export function getKaspaTxFormat(paymentRequirements) {
  const txFormat = paymentRequirements?.extra?.txFormat ?? TX_FORMAT;
  assertString(txFormat, "extra.txFormat");
  return txFormat;
}

export function createKaspaExactPaymentRequirements({
  merchantAddress,
  amountSompi,
  maxFeeSompi,
  network = DEFAULT_NETWORK,
  asset = DEFAULT_ASSET,
  maxTimeoutSeconds = 300
}) {
  const requirement = {
    scheme: SCHEME_NAME,
    network,
    amount: String(amountSompi),
    asset,
    payTo: merchantAddress,
    maxTimeoutSeconds,
    extra: {
      txFormat: TX_FORMAT,
      maxFeeSompi
    }
  };

  assertPaymentRequirements(requirement);
  return requirement;
}

export function createPaymentRequired({
  resource,
  error = "PAYMENT-SIGNATURE header is required",
  paymentRequirements,
  paymentId
}) {
  const paymentRequired = {
    x402Version: X402_VERSION,
    error,
    resource,
    accepts: [paymentRequirements],
    extensions: withPaymentIdentifierExtension({}, paymentId)
  };

  assertPaymentRequired(paymentRequired);
  return paymentRequired;
}

export function createPaymentPayload({
  resource,
  accepted,
  quoteId,
  transaction,
  paymentId,
  extensions
}) {
  const paymentPayload = {
    x402Version: X402_VERSION,
    resource,
    accepted,
    payload: {
      quoteId,
      transaction,
      txFormat: getKaspaTxFormat(accepted)
    },
    extensions: withPaymentIdentifierExtension(extensions, paymentId)
  };

  assertPaymentPayload(paymentPayload);
  return paymentPayload;
}

export function createVerifyRequest({
  paymentPayload,
  paymentRequirements
}) {
  const request = {
    x402Version: X402_VERSION,
    paymentPayload,
    paymentRequirements
  };

  assertVerifyRequest(request);
  return request;
}

export function createSettlementResponse({
  success,
  transaction,
  network,
  payer,
  errorReason,
  extensions
}) {
  const settlementResponse = {
    success,
    transaction,
    network,
    payer,
    ...(success ? {} : { errorReason }),
    ...(extensions ? { extensions } : {})
  };

  assertSettlementResponse(settlementResponse);
  return settlementResponse;
}

export function createSupportedResponse({
  network = DEFAULT_NETWORK,
  asset = DEFAULT_ASSET,
  signers = { "kaspa:*": [] }
} = {}) {
  return {
    kinds: [
      {
        x402Version: X402_VERSION,
        scheme: SCHEME_NAME,
        network,
        extra: {
          asset,
          txFormat: TX_FORMAT
        }
      }
    ],
    extensions: [PAYMENT_IDENTIFIER_EXTENSION],
    signers
  };
}
