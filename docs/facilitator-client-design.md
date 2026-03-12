# Facilitator and Client Design

This repo now uses a split that preserves the trust-minimized Kaspa signing model without replacing the x402 public transport.

## Current Split

- Merchant owns the standard x402 HTTP surface:
  - `402` plus `PAYMENT-REQUIRED`
  - retry with `PAYMENT-SIGNATURE`
  - final `PAYMENT-RESPONSE`
- Facilitator owns Kaspa-specific operations:
  - build unsigned PSKBs
  - verify signed PSKBs
  - broadcast to TN12
  - persist settlement state
- Client owns wallet operations:
  - derive payer addresses
  - inspect the real unsigned PSKB
  - sign locally with the vendored WASM SDK

## Why The Facilitator Still Prepares The Transaction

The current vendored JS/WASM SDK is used for local signing and inspection, but the repo’s active TN12 transaction construction and broadcast path still lives in the Rust facilitator runtime.

That keeps the repo simple:

- no always-on bridge process
- no payer mnemonic leaves the client
- no blind signing of facilitator-generated data

## Current Request Path

1. Merchant returns `402` with `PAYMENT-REQUIRED`.
2. Client sends `paymentRequirements` plus payer address context to facilitator `/v2/x402/prepare`.
3. Facilitator builds an unsigned PSKB from live TN12 UTXOs and returns the signing summary.
4. Client verifies the summary and the actual PSKB outputs locally.
5. Client signs the PSKB locally.
6. Client retries the merchant request with `PAYMENT-SIGNATURE`.
7. Merchant calls facilitator `/v2/x402/verify`.
8. Merchant calls facilitator `/v2/x402/settle`.
9. Facilitator broadcasts, verifies the merchant output on-chain, and returns settlement data.
10. Merchant unlocks and returns `PAYMENT-RESPONSE`.

## What Is Still Deferred

Possible follow-ups remain:

- direct TN12 construction and broadcast in the client once the JS toolchain supports it cleanly
- confirmation tracking beyond the current merchant-output-seen verification
- moving the Kaspa `exact` mapping into a more formal external scheme spec if the repo is upstreamed

Those are follow-ups, not blockers for the active flow in this repo.
