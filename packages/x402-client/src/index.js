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
  encodeReceiptHeader
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
  walletMnemonic = DEFAULT_PAYER_MNEMONIC
}) {
  const firstResponse = await fetch(resourceUrl);
  if (firstResponse.status !== 402) {
    return {
      step: "initial-response",
      status: firstResponse.status,
      body: await firstResponse.text()
    };
  }

  const challenge = await readJson(firstResponse);
  const requirement = challenge.requirement;
  const walletStatus = await deriveAddressFromMnemonic({
    mnemonic: walletMnemonic,
    network: requirement.network
  });
  const walletCandidates = await deriveAddressCandidatesFromMnemonic({
    mnemonic: walletMnemonic,
    network: requirement.network
  });

  const quote = await fetchJson(`${requirement.facilitatorUrl}/quotes`, {
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

  const transactionInspection = await inspectUnsignedTransaction({
    unsignedTransaction: quote.unsignedTransaction,
    network: requirement.network,
    requirement,
    signingSummary: quote.signingSummary
  });

  const signed = await signUnsignedTransaction({
    unsignedTransaction: quote.unsignedTransaction,
    mnemonic: walletMnemonic,
    network: requirement.network
  });

  const receipt = await fetchJson(`${requirement.facilitatorUrl}/submit`, {
    method: "POST",
    headers: {
      "content-type": JSON_CONTENT_TYPE
    },
    body: JSON.stringify({
      quoteId: quote.quoteId,
      signedTransaction: signed.signedTransaction
    })
  });
  const payment = {
    txid: receipt.txid,
    payerAddress: signed.payerAddress
  };
  const retryResponse = await fetch(resourceUrl, {
    headers: {
      "x-payment-receipt": encodeReceiptHeader(receipt)
    }
  });

  return {
    step: "completed",
    walletStatus,
    requirement,
    quote,
    transactionInspection,
    payment,
    receipt,
    finalStatus: retryResponse.status,
    finalBody: await retryResponse.text()
  };
}
