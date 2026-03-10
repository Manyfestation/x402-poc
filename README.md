# x402 POC

This repo is a local x402 payment flow on Kaspa.

It runs three entities:

- `Merchant`: paywalls `GET /premium` and returns an x402 payment requirement.
- `Facilitator`: turns that requirement into an unsigned Kaspa transaction, accepts the signed transaction back, broadcasts it, and records a receipt.
- `Client`: the browser UI. It receives the payment requirement, checks the unsigned transaction before signing, signs with the Kaspa WASM SDK, and retries the merchant request with the receipt.

The important trust boundary is this: the facilitator prepares and broadcasts, but the client does not sign blindly. Before signing, the client reads the unsigned PSKB and checks that it sends the required amount to the merchant address, that the change output matches what the facilitator claimed, and that the fee stays within the allowed limit.

## Entity Map

```text
Client UI            Merchant               Facilitator             Kaspa TN12
    |                    |                        |                       |
    | GET /premium       |                        |                       |
    |------------------->|                        |                       |
    |                    | 402 + pay request      |                       |
    |<-------------------|                        |                       |
    |                    |                        |                       |
    | ask facilitator to build the unsigned tx    |                       |
    |-------------------------------------------->|                       |
    |                    |                        | unsigned PSKB +       |
    |<--------------------------------------------| expected outputs/fee  |
    |                    |                        |                       |
    | check merchant output, change, and fee      |                       |
    | sign transaction locally                    |                       |
    | send signed tx                              |                       |
    |-------------------------------------------->|                       |
    |                    |                        |---------------------->|
    |                    |                        |                       |
    |                    |                        | receipt after         |
    |<--------------------------------------------| successful broadcast  |
    |                    |                        |                       |
    | retry /premium with receipt                 |                       |
    |------------------->|                        |                       |
    |                    | validate receipt ----->|                       |
    |                    |<-----------------------|                       |
    | 200 unlocked       |                        |                       |
    |<-------------------|                        |                       |
```

## Entities

### Merchant

- Serves the protected resource at `http://127.0.0.1:4022/premium`.
- Returns `402 Payment Required` with an x402 requirement when the request is unpaid.
- Verifies the facilitator receipt before unlocking the resource.
- Implemented in `apps/merchant-demo/src/index.js`.

### Facilitator

- Serves `http://127.0.0.1:4021`.
- Accepts a payment requirement and payer addresses at `POST /quotes`.
- Fetches live TN12 UTXOs, builds an unsigned `kaspa-unsigned-transaction-v1` PSKB, and returns the transaction plus the fields the client should see in it.
- Accepts the signed transaction at `POST /submit`.
- Broadcasts to TN12, verifies the merchant output, persists the receipt, and exposes it at `GET /payments/:paymentId`.
- Implemented in `apps/facilitator/src/main.rs`.

### Client

- Requests the protected resource.
- Receives the x402 payment requirement.
- Requests a quote from the facilitator.
- Reads the unsigned PSKB locally and checks the actual transaction before signing.
- Confirms that the transaction pays the merchant address, pays the required amount, uses the expected change output, and stays within the fee limit.
- Signs the PSKB locally with the Kaspa WASM SDK.
- Submits the signed transaction and retries the merchant request with the receipt.
- Browser flow and payment sequence: `apps/web-ui/public/app.js`
- Browser-side PSKB read/check/sign logic: `apps/web-ui/public/kaspa-wallet.js`

## How The Flow Works

1. The client requests `GET /premium` from the merchant.
2. The merchant returns `402` plus the x402 requirement: merchant address, amount, expiry, and facilitator URL.
3. The client sends that requirement plus payer address context to the facilitator `POST /quotes`.
4. The facilitator fetches live payer UTXOs on TN12 and returns:
   - `txFormat: "kaspa-unsigned-transaction-v1"`
   - `unsignedTransaction` as a PSKB payload
   - transaction details the client must match against the PSKB before signing
5. The client checks that the facilitator did not change the merchant address, the amount, the change output, or the fee.
6. The client deserializes the unsigned PSKB locally and checks the actual outputs in the transaction itself.
7. The client signs locally with the vendored Kaspa WASM SDK.
8. The client posts `{ quoteId, signedTransaction }` to `POST /submit`.
9. The facilitator broadcasts the signed transaction, verifies the merchant output, stores a receipt, and returns it.
10. The client retries the merchant request with `x-payment-receipt`.
11. The merchant checks the facilitator record and unlocks the resource.

## Run It

From `x402-kaspa-poc`:

```bash
npm install
npm run dev
```

This starts:

- Facilitator on `http://127.0.0.1:4021`
- Merchant on `http://127.0.0.1:4022`
- UI on `http://127.0.0.1:4023`

Then open `http://127.0.0.1:4023`.

The UI `Pay` flow does the full path end to end: quote, check the transaction, sign locally, submit, receive receipt, retry merchant.

If you want to run services separately:

```bash
npm run facilitator
npm run merchant
npm run ui
```

## Default Wallets

The repo ships with hardcoded, funded testnet wallets for the payer and merchant so the flow works out of the box on TN12.

Those defaults are overrideable with environment variables:

- `X402_PAYER_MNEMONIC`
- `X402_MERCHANT_MNEMONIC`
- `X402_MERCHANT_ADDRESS`

The browser UI exposes the payer mnemonic only through a local endpoint so browser signing works in local development. That is not a production pattern.

## Requirements

- Node.js `>=25`
- Rust toolchain
- Local Kaspa WASM SDK at `.local/kaspa-wasm32-sdk` by default

To override the SDK path:

```bash
export X402_KASPA_WASM_SDK_ROOT="/path/to/kaspa-wasm32-sdk"
```

## Environment

Useful overrides:

- `X402_KASPA_WASM_SDK_ROOT`
- `X402_KASPA_WASM_SDK_FLAVOR`
- `X402_KASPA_WRPC_URL`
- `X402_HTTP_TIMEOUT_MS`
- `X402_PAYER_MNEMONIC`
- `X402_MERCHANT_MNEMONIC`
- `X402_MERCHANT_ADDRESS`
- `X402_FACILITATOR_URL`
- `X402_FACILITATOR_STATE_FILE`

Defaults worth knowing:

- TN12 wRPC endpoint: `wss://tn12reset-wrpc.kasia.fyi`
- Facilitator state file: `apps/facilitator/.data/facilitator-state.json`
- WASM flavor: `kaspa-dev` by default, because the plain `kaspa` bundle here does not support `testnet-12`

## Verification

```bash
npm test
npm run proof:e2e
```

The end-to-end proof requires the active payer wallet to have spendable TN12 funds. When it does, the proof checks that:

- the merchant first returns `402`
- the facilitator returns an unsigned x402 Kaspa quote
- the client checks the transaction and signs locally
- the facilitator returns a real txid
- the merchant unlocks on retry
