# Kaspa x402 V2 Mapping

This repo implements Kaspa as an `exact` x402 payment kind over the V2 HTTP transport.

## Public Merchant Contract

### Unpaid Response

`GET /premium` returns:

- HTTP `402 Payment Required`
- `PAYMENT-REQUIRED` header containing a base64-encoded `PaymentRequired`

Example decoded header:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "http://127.0.0.1:4022/premium",
    "description": "Kaspa x402 premium content",
    "mimeType": "text/plain; charset=utf-8"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "kaspa:testnet-12",
      "amount": "10000000",
      "asset": "kaspa:testnet-12/slip44:111111",
      "payTo": "kaspatest:qp...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "txFormat": "kaspa-unsigned-transaction-v1",
        "maxFeeSompi": 200000
      }
    }
  ],
  "extensions": {
    "payment-identifier": {
      "info": {},
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "paymentId": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

### Paid Response

The client retries the same request with a base64-encoded `PaymentPayload` in `PAYMENT-SIGNATURE`.

Example decoded header:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://127.0.0.1:4022/premium",
    "description": "Kaspa x402 premium content",
    "mimeType": "text/plain; charset=utf-8"
  },
  "accepted": {
    "scheme": "exact",
    "network": "kaspa:testnet-12",
    "amount": "10000000",
    "asset": "kaspa:testnet-12/slip44:111111",
    "payTo": "kaspatest:qp...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "txFormat": "kaspa-unsigned-transaction-v1",
      "maxFeeSompi": 200000
    }
  },
  "payload": {
    "quoteId": "quote_0000000000000001",
    "transaction": "PSKB...",
    "txFormat": "kaspa-unsigned-transaction-v1"
  },
  "extensions": {
    "payment-identifier": {
      "info": {
        "paymentId": "payment_123"
      },
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "paymentId": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

After successful settlement, the merchant returns `200 OK` with `PAYMENT-RESPONSE`.

Example decoded response header:

```json
{
  "success": true,
  "transaction": "0123abcd...",
  "network": "kaspa:testnet-12",
  "payer": "kaspatest:qp...",
  "extensions": {
    "payment-identifier": {
      "info": {
        "paymentId": "payment_123"
      },
      "schema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "paymentId": {
            "type": "string"
          }
        }
      }
    }
  }
}
```

## Kaspa Helper Endpoint

Kaspa still needs facilitator-side PSKB construction. The repo keeps that behind:

- `POST /v2/x402/prepare`

Example request:

```json
{
  "paymentRequirements": {
    "scheme": "exact",
    "network": "kaspa:testnet-12",
    "amount": "10000000",
    "asset": "kaspa:testnet-12/slip44:111111",
    "payTo": "kaspatest:qp...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "txFormat": "kaspa-unsigned-transaction-v1",
      "maxFeeSompi": 200000
    }
  },
  "payerAddress": "kaspatest:qpayer...",
  "payerAddresses": [
    "kaspatest:qpayer...",
    "kaspatest:qchange..."
  ]
}
```

Example response:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "txFormat": "kaspa-unsigned-transaction-v1",
  "quoteId": "quote_0000000000000001",
  "paymentRequirements": {
    "...": "..."
  },
  "unsignedTransaction": "PSKB...",
  "signingSummary": {
    "payerAddress": "kaspatest:qpayer...",
    "merchantAddress": "kaspatest:qp...",
    "selectedInputs": [
      {
        "outpoint": "abcd...:0",
        "address": "kaspatest:qpayer...",
        "amountSompi": 99899990000
      }
    ],
    "totalInputSompi": 99899990000,
    "transferAmountSompi": 10000000,
    "changeAddress": "kaspatest:qpayer...",
    "changeAmountSompi": 99889890000,
    "feeSompi": 100000,
    "txCount": 1
  },
  "payerContext": {
    "payerAddress": "kaspatest:qpayer..."
  },
  "createdAt": "2026-03-11T12:00:00.000Z",
  "expiresAt": "2026-03-11T12:05:00.000Z"
}
```

This helper is not the merchant-facing payment protocol. It only exists so the client can inspect the real Kaspa transaction before signing.

## Facilitator Endpoints

- `GET /v2/x402/supported`
- `POST /v2/x402/verify`
- `POST /v2/x402/settle`

`/verify` and `/settle` both accept:

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "...": "..."
  },
  "paymentRequirements": {
    "...": "..."
  }
}
```

## Client Verification Rules

Before sending `PAYMENT-SIGNATURE`, the client verifies:

- the facilitator quote echoes the advertised `PaymentRequirements`
- the PSKB contains the exact `payTo` output
- the PSKB merchant amount exactly equals `amount`
- the PSKB fee does not exceed `extra.maxFeeSompi`
- the PSKB change output matches the facilitator summary
- the quote only uses payer-controlled inputs

## Facilitator Verification Rules

Before settlement, the facilitator verifies:

- `paymentPayload.accepted` exactly matches `paymentRequirements`
- the quote referenced by `payload.quoteId` exists and is unexpired
- the signed PSKB keeps the prepared input set
- the merchant output still matches `payTo`
- the merchant amount still matches `amount`
- the change output still matches the prepared quote
- the fee stays within `maxFeeSompi`

## Settlement

Settlement is:

1. client signs the prepared PSKB locally
2. merchant forwards `PaymentPayload` to facilitator `/verify`
3. merchant forwards the same payload to `/settle`
4. facilitator broadcasts the signed PSKB to TN12
5. facilitator verifies the merchant output on-chain
6. merchant returns `PAYMENT-RESPONSE`
