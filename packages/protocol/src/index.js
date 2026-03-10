import { createHash, randomUUID } from "node:crypto";

export const SCHEME_NAME = "exact-kaspa-address-v0";
export const DEFAULT_NETWORK = "kaspa:testnet-12";
export const TX_FORMAT = "kaspa-unsigned-transaction-v1";
export const REAL_TX_FORMAT = TX_FORMAT;
export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

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

export function encodeReceiptHeader(receipt) {
  return Buffer.from(JSON.stringify(receipt), "utf8").toString("base64url");
}

export function decodeReceiptHeader(headerValue) {
  const json = Buffer.from(headerValue, "base64url").toString("utf8");
  return JSON.parse(json);
}

export function assertPaymentRequirement(requirement) {
  if (!requirement || typeof requirement !== "object") {
    throw new Error("payment requirement must be an object");
  }

  const required = [
    "scheme",
    "network",
    "paymentId",
    "resource",
    "merchantAddress",
    "amountSompi",
    "maxFeeSompi",
    "facilitatorUrl",
    "expiresAt"
  ];

  for (const key of required) {
    if (!(key in requirement)) {
      throw new Error(`payment requirement is missing ${key}`);
    }
  }

  if (requirement.scheme !== SCHEME_NAME) {
    throw new Error(`unsupported scheme: ${requirement.scheme}`);
  }
}

export function createPaymentRequirement({
  paymentId = createId("pay"),
  resource,
  merchantAddress,
  amountSompi,
  maxFeeSompi,
  facilitatorUrl,
  network = DEFAULT_NETWORK,
  expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
}) {
  const requirement = {
    scheme: SCHEME_NAME,
    network,
    paymentId,
    resource,
    merchantAddress,
    amountSompi,
    maxFeeSompi,
    facilitatorUrl,
    expiresAt
  };

  assertPaymentRequirement(requirement);
  return requirement;
}

export function createQuoteRequest({
  paymentId,
  payerAddress,
  changeAddress,
  payerPublicKeyPem,
  txFormat = TX_FORMAT
}) {
  return {
    paymentId,
    payerAddress,
    changeAddress,
    payerPublicKeyPem,
    clientCapabilities: {
      txFormat
    }
  };
}
