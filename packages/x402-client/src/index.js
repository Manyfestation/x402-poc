import { verifyTransactionQuoteForPayer } from "@x402-kaspa/kaspa-core";
import {
  DEFAULT_PAYER_MNEMONIC,
  deriveAddressCandidatesFromMnemonic,
  deriveAddressFromMnemonic,
  inspectUnsignedTransaction,
  signUnsignedTransaction
} from "@x402-kaspa/kaspa-wasm";
import {
  JSON_CONTENT_TYPE,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  createId,
  createPaymentPayload,
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader
} from "@x402-kaspa/protocol";

async function readJson(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(payload?.error ?? `request failed with ${response.status}`);
  }

  return payload;
}

export async function payProtectedResource({
  resourceUrl,
  facilitatorUrl,
  walletMnemonic = DEFAULT_PAYER_MNEMONIC
}) {
  if (!facilitatorUrl) {
    throw new Error("facilitatorUrl is required");
  }

  const firstResponse = await fetch(resourceUrl);
  if (firstResponse.status !== 402) {
    return {
      step: "initial-response",
      status: firstResponse.status,
      body: await firstResponse.text()
    };
  }

  const paymentRequiredHeader = firstResponse.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!paymentRequiredHeader) {
    throw new Error("merchant returned 402 without PAYMENT-REQUIRED");
  }

  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
  const paymentRequirements = paymentRequired.accepts[0];
  const walletStatus = await deriveAddressFromMnemonic({
    mnemonic: walletMnemonic,
    network: paymentRequirements.network
  });
  const walletCandidates = await deriveAddressCandidatesFromMnemonic({
    mnemonic: walletMnemonic,
    network: paymentRequirements.network
  });

  const quote = await fetchJson(`${facilitatorUrl}/v2/x402/prepare`, {
    method: "POST",
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    body: JSON.stringify({
      paymentRequirements,
      payerAddress: walletStatus.address,
      payerAddresses: walletCandidates.addresses
    })
  });

  verifyTransactionQuoteForPayer({
    quote,
    paymentRequirements,
    payerAddresses: walletCandidates.addresses
  });

  const transactionInspection = await inspectUnsignedTransaction({
    unsignedTransaction: quote.unsignedTransaction,
    network: paymentRequirements.network,
    requirement: paymentRequirements,
    signingSummary: quote.signingSummary
  });

  const signed = await signUnsignedTransaction({
    unsignedTransaction: quote.unsignedTransaction,
    mnemonic: walletMnemonic,
    network: paymentRequirements.network
  });

  const paymentPayload = createPaymentPayload({
    resource: paymentRequired.resource,
    accepted: paymentRequirements,
    quoteId: quote.quoteId,
    transaction: signed.signedTransaction,
    paymentId: createId("payment")
  });
  const retryResponse = await fetch(resourceUrl, {
    headers: {
      [PAYMENT_SIGNATURE_HEADER]: encodePaymentSignatureHeader(paymentPayload)
    }
  });
  const settlementResponseHeader = retryResponse.headers.get(PAYMENT_RESPONSE_HEADER);
  const settlementResponse = settlementResponseHeader
    ? decodePaymentResponseHeader(settlementResponseHeader)
    : null;

  return {
    step: retryResponse.ok ? "completed" : "payment-failed",
    walletStatus,
    paymentRequired,
    paymentRequirements,
    quote,
    transactionInspection,
    paymentPayload,
    settlementResponse,
    finalStatus: retryResponse.status,
    finalBody: await retryResponse.text()
  };
}
