# Facilitator and Client Design

This repo now ships the active no-bridge TN12 architecture.

## Current Split

- Merchant owns the `402 Payment Required` challenge and receipt-gated content.
- Facilitator owns quote ids, unsigned PSKB construction, TN12 broadcast, tx verification, receipt issuance, and stored payment state.
- Client owns payer address derivation, quote verification, and local PSKB signing with the vendored WASM SDK.

## Why The Facilitator Builds And Broadcasts

The current vendored JS/WASM SDK can sign facilitator-provided PSKBs locally, but it is still not the active TN12 transaction constructor or broadcaster for this repo.

That means the clean split today is:

- facilitator handles TN12-only operations through the real Rust `tn12` branch
- client keeps the payer keys and only signs

This avoids:

- a separate always-on bridge process
- giving the facilitator the payer mnemonic
- trying to force the current JS SDK to generate or submit TN12 transactions directly

## Current Request Path

1. Merchant returns `402` and the payment requirement.
2. Client sends `{ requirement, payerAddress }` to facilitator `/quotes`.
3. Facilitator builds an unsigned PSKB from public payer UTXOs and returns the signing summary.
4. Client verifies the summary and signs the PSKB locally.
5. Client sends `{ quoteId, signedTransaction }` to facilitator `/submit`.
6. Facilitator broadcasts the signed PSKB to TN12, verifies the merchant output, stores the accepted receipt, and returns it.
7. Merchant verifies that stored facilitator record and unlocks.

## What Is Still Deferred

Possible follow-ups remain:

- replacing the vendored JS SDK with a TN12-capable build that can also construct and broadcast directly
- confirmation tracking beyond the current output-appears-on-chain verification
- keeping the facilitator runtime under `apps/facilitator`

Those are follow-ups, not blockers for the active repo flow.
