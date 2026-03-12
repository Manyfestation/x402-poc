import {
  REAL_TX_FORMAT,
  SCHEME_NAME,
  getKaspaMaxFeeSompi,
  samePaymentRequirements
} from "@x402-kaspa/protocol";

export function verifyTransactionQuoteForPayer({
  quote,
  paymentRequirements,
  payerAddress,
  payerAddresses
}) {
  if (!quote || typeof quote !== "object") {
    throw new Error("quote must be an object");
  }

  if (!paymentRequirements || typeof paymentRequirements !== "object") {
    throw new Error("payment requirement must be an object");
  }

  const allowedPayerAddresses = Array.isArray(payerAddresses)
    ? payerAddresses.filter((value) => typeof value === "string" && value)
    : [];
  if (payerAddress && typeof payerAddress === "string") {
    allowedPayerAddresses.push(payerAddress);
  }

  if (allowedPayerAddresses.length === 0) {
    throw new Error("payerAddress or payerAddresses is required");
  }

  if (quote.scheme !== SCHEME_NAME) {
    throw new Error(`unsupported quote scheme: ${quote.scheme}`);
  }

  if (quote.txFormat !== REAL_TX_FORMAT) {
    throw new Error(`unexpected tx format: ${quote.txFormat}`);
  }

  if (!quote.unsignedTransaction || typeof quote.unsignedTransaction !== "string") {
    throw new Error("quote is missing an unsigned transaction payload");
  }

  if (!quote.paymentRequirements || typeof quote.paymentRequirements !== "object") {
    throw new Error("quote is missing the payment requirements");
  }

  if (!samePaymentRequirements(quote.paymentRequirements, paymentRequirements)) {
    throw new Error("quote payment requirements mismatch");
  }

  if (!quote.payerContext || typeof quote.payerContext !== "object") {
    throw new Error("quote is missing payer context");
  }

  if (!allowedPayerAddresses.includes(quote.payerContext.payerAddress)) {
    throw new Error("quote payer address does not match the signing wallet");
  }

  const summary = quote.signingSummary;
  if (!summary || typeof summary !== "object") {
    throw new Error("quote is missing a signing summary");
  }

  if (!allowedPayerAddresses.includes(summary.payerAddress)) {
    throw new Error("signing summary payer address mismatch");
  }

  if (summary.merchantAddress !== paymentRequirements.payTo) {
    throw new Error("merchant output address mismatch");
  }

  if (String(summary.transferAmountSompi) !== paymentRequirements.amount) {
    throw new Error("merchant output amount mismatch");
  }

  if (!Array.isArray(summary.selectedInputs) || summary.selectedInputs.length === 0) {
    throw new Error("signing summary is missing payer inputs");
  }

  if (typeof summary.totalInputSompi !== "number" || summary.totalInputSompi < Number(paymentRequirements.amount)) {
    throw new Error("signing summary total input is invalid");
  }

  if (typeof summary.feeSompi !== "number" || summary.feeSompi < 0) {
    throw new Error("signing summary fee is invalid");
  }

  if (summary.feeSompi > getKaspaMaxFeeSompi(paymentRequirements)) {
    throw new Error("quoted fee exceeds the payment requirement max fee");
  }

  if (typeof summary.changeAddress !== "string" || !summary.changeAddress) {
    throw new Error("signing summary is missing a change address");
  }

  if (typeof summary.changeAmountSompi !== "number" || summary.changeAmountSompi < 0) {
    throw new Error("signing summary change amount is invalid");
  }

  if (summary.totalInputSompi !== summary.transferAmountSompi + summary.changeAmountSompi + summary.feeSompi) {
    throw new Error("signing summary totals do not balance");
  }

  if (summary.txCount !== 1) {
    throw new Error(`quote returned ${summary.txCount} transactions; this demo expects a single tx`);
  }

  return summary;
}

export const verifyPskbQuoteForPayer = verifyTransactionQuoteForPayer;
