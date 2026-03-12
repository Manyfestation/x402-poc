# x402 Kaspa POC

This repo is a local Kaspa implementation of the x402 V2 HTTP transport.

The public payment contract is now standard x402:

- merchant returns `402 Payment Required` with a `PAYMENT-REQUIRED` header
- client retries the same request with `PAYMENT-SIGNATURE`
- merchant calls facilitator `/v2/x402/verify` and `/v2/x402/settle`
- merchant returns the protected resource plus `PAYMENT-RESPONSE`

Kaspa-specific transaction preparation still exists, but it sits behind the standard transport as a scheme helper. The client asks the facilitator for an unsigned PSKB at `/v2/x402/prepare`, inspects the transaction locally, signs locally, and only then sends the standard `PaymentPayload` back to the merchant.

## Flow

```text
Client UI            Merchant                    Facilitator               Kaspa TN12
    |                    |                             |                        |
    | GET /premium       |                             |                        |
    |------------------->|                             |                        |
    |                    | 402 + PAYMENT-REQUIRED      |                        |
    |<-------------------|                             |                        |
    |                    |                             |                        |
    | POST /v2/x402/prepare                            |                        |
    |------------------------------------------------->|                        |
    |                    |                             | unsigned PSKB          |
    |<-------------------------------------------------| + signing summary      |
    |                    |                             |                        |
    | inspect PSKB locally and sign                    |                        |
    |                    |                             |                        |
    | retry GET /premium with PAYMENT-SIGNATURE        |                        |
    |------------------->|                             |                        |
    |                    | POST /v2/x402/verify        |                        |
    |                    |---------------------------->|                        |
    |                    | POST /v2/x402/settle        |                        |
    |                    |---------------------------->| broadcast + verify     |
    |                    |<----------------------------| PAYMENT-RESPONSE data  |
    | 200 + PAYMENT-RESPONSE                           |                        |
    |<-------------------|                             |                        |
```

## Components

### Merchant

- serves `http://127.0.0.1:4022/premium`
- emits `PAYMENT-REQUIRED`
- accepts `PAYMENT-SIGNATURE`
- delegates verify and settle to the facilitator

### Facilitator

- serves `http://127.0.0.1:4021`
- standard endpoints:
  - `GET /v2/x402/supported`
  - `POST /v2/x402/verify`
  - `POST /v2/x402/settle`
- Kaspa helper endpoint:
  - `POST /v2/x402/prepare`
- builds unsigned PSKBs, validates signed payloads, broadcasts to TN12, and persists settled payments

### Client

- requests the protected resource
- decodes the x402 challenge from `PAYMENT-REQUIRED`
- asks the facilitator to prepare the unsigned PSKB
- verifies the real outputs, change output, and fee before signing
- signs locally with the Kaspa WASM SDK
- retries the same merchant request with a standard `PaymentPayload`

## Kaspa Exact Mapping

The repo maps Kaspa onto the standard `exact` scheme.

- `scheme`: `exact`
- `network`: `kaspa:testnet-12`
- `asset`: `kaspa:testnet-12/slip44:111111`
- `payTo`: merchant Kaspa address
- `amount`: sompi as a string
- `maxTimeoutSeconds`: x402 timeout window
- `extra.maxFeeSompi`: fee ceiling the client enforces before signing
- `extra.txFormat`: `kaspa-unsigned-transaction-v1`

The `payment-identifier` extension is used to carry the client-generated payment id through the payment payload and settlement response.

## Run It

```bash
npm install
npm run dev
```

This starts:

- facilitator on `http://127.0.0.1:4021`
- merchant on `http://127.0.0.1:4022`
- UI on `http://127.0.0.1:4023`

Then open `http://127.0.0.1:4023`.

If you want to run services separately:

```bash
npm run facilitator
npm run merchant
npm run ui
```

## Default Wallets

The repo ships with hardcoded TN12 payer and merchant wallets so the flow works out of the box when those wallets have spendable funds.

Overrideable environment variables:

- `X402_PAYER_MNEMONIC`
- `X402_MERCHANT_MNEMONIC`
- `X402_MERCHANT_ADDRESS`

The browser UI exposes the payer mnemonic only through a local endpoint so browser signing works in local development. That is not a production pattern.

## Requirements

- Node.js `>=25`
- Rust toolchain
- local Kaspa WASM SDK at `.local/kaspa-wasm32-sdk` by default

Override the SDK path with:

```bash
export X402_KASPA_WASM_SDK_ROOT="/path/to/kaspa-wasm32-sdk"
```

## Environment

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
- facilitator state file: `apps/facilitator/.data/facilitator-state.json`
- WASM flavor: `kaspa-dev`

## Verification

```bash
npm test
cargo check --manifest-path apps/facilitator/Cargo.toml
npm run proof:e2e
```

The end-to-end proof requires the active payer wallet to have spendable TN12 funds. When it does, the proof checks that:

- the merchant first returns `402` with `PAYMENT-REQUIRED`
- the facilitator returns an unsigned Kaspa PSKB from `/v2/x402/prepare`
- the client checks the transaction and signs locally
- the merchant settles through `/v2/x402/settle`
- the merchant unlocks with `PAYMENT-RESPONSE`
