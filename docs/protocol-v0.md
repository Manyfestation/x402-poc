# `exact-kaspa-address-v0`

`exact-kaspa-address-v0` is still a repo-local x402 scheme name, but the settlement artifact is now a real unsigned PSKB prepared by the facilitator on TN12 and signed locally by the client.

## Network

```json
{
  "network": "kaspa:testnet-12"
}
```

## Payment Requirement

```json
{
  "scheme": "exact-kaspa-address-v0",
  "network": "kaspa:testnet-12",
  "paymentId": "pay_123",
  "resource": "GET /premium",
  "merchantAddress": "kaspatest:qp...",
  "amountSompi": 10000000,
  "maxFeeSompi": 200000,
  "facilitatorUrl": "http://127.0.0.1:4021",
  "expiresAt": "2026-03-09T12:00:00.000Z"
}
```

## Quote Response

```json
{
  "scheme": "exact-kaspa-address-v0",
  "txFormat": "kaspa-unsigned-transaction-v1",
  "quoteId": "quote_123",
  "requirement": { "...": "..." },
  "unsignedTransaction": "PSKB...",
  "signingSummary": {
    "payerAddress": "kaspatest:qp...",
    "merchantAddress": "kaspatest:qm...",
    "selectedInputs": [
      {
        "outpoint": "abcd...:0",
        "address": "kaspatest:qp...",
        "amountSompi": 99899990000
      }
    ],
    "totalInputSompi": 99899990000,
    "transferAmountSompi": 10000000,
    "changeAddress": "kaspatest:qp...",
    "changeAmountSompi": 99889890000,
    "feeSompi": 100000,
    "txCount": 1
  },
  "payerContext": {
    "payerAddress": "kaspatest:qp..."
  },
  "createdAt": "2026-03-09T12:00:00.000Z",
  "expiresAt": "2026-03-09T12:05:00.000Z"
}
```

## Client Verification Rules

Before signing or submitting, the client must verify:

- `scheme == "exact-kaspa-address-v0"`
- `txFormat == "kaspa-unsigned-transaction-v1"`
- quote `requirement` matches the merchant requirement
- the quote includes an `unsignedTransaction` payload that starts with `PSKB`
- `payerContext.payerAddress` matches the local payer address
- `signingSummary.merchantAddress` matches the merchant requirement
- `signingSummary.transferAmountSompi` matches the required amount
- `signingSummary.feeSompi <= maxFeeSompi`
- `signingSummary.totalInputSompi == transfer + change + fee`
- `signingSummary.txCount == 1`

## Settlement

Current settlement in this repo is:

1. Facilitator prepares the unsigned PSKB from the wallet’s candidate payer addresses and live TN12 UTXOs.
2. Client signs that PSKB locally with the WASM SDK.
3. Client submits `POST /submit` with `{ quoteId, signedTransaction }`.
4. Facilitator broadcasts the signed PSKB to TN12.
5. Facilitator verifies the merchant output on-chain.
6. Facilitator stores the accepted payment record and returns a receipt.
7. Merchant unlocks only after checking the facilitator payment record.

## Receipt

```json
{
  "scheme": "exact-kaspa-address-v0",
  "paymentId": "pay_123",
  "quoteId": "quote_123",
  "txid": "0123abcd...",
  "payerAddress": "kaspatest:qp...",
  "merchantAddress": "kaspatest:qm...",
  "amountSompi": 10000000,
  "feeSompi": 100000,
  "status": "accepted",
  "acceptedAt": "2026-03-09T12:00:03.000Z"
}
```
