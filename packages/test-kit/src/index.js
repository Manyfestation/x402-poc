import {
  createKaspaExactPaymentRequirements,
  createPaymentRequired
} from "@x402-kaspa/protocol";

export const FACILITATOR_PORT = 4021;
export const MERCHANT_PORT = 4022;
export const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;
export const MERCHANT_URL = `http://127.0.0.1:${MERCHANT_PORT}`;
export const PREMIUM_RESOURCE_PATH = "/premium";
export const PREMIUM_RESOURCE_URL = `${MERCHANT_URL}${PREMIUM_RESOURCE_PATH}`;

export const DEMO_PAYER = {
  label: "demo-payer",
  address: "kaspatest:9329496938acc2c0d2216580c6cfa8033dc05648",
  privateKeyPem: `-----BEGIN PRIVATE KEY-----
MIGEAgEAMBAGByqGSM49AgEGBSuBBAAKBG0wawIBAQQgDCc1g+B4yqaQq1dp1h3u
nU6YPXLDFFcKwYubtfPzecmhRANCAATgvle5ZP/LXCG5Tu+ph6gg6M/bF3/VlA2/
5Sxv7s7ZnYoy/9oz5o3eiNo7EYRWG7nzbc42i7sgjPjt6UKXSMZm
-----END PRIVATE KEY-----
`,
  publicKeyPem: `-----BEGIN PUBLIC KEY-----
MFYwEAYHKoZIzj0CAQYFK4EEAAoDQgAE4L5XuWT/y1whuU7vqYeoIOjP2xd/1ZQN
v+Usb+7O2Z2KMv/aM+aN3ojaOxGEVhu5823ONou7IIz47elCl0jGZg==
-----END PUBLIC KEY-----
`
};

export const DEMO_CHANGE_ADDRESS = DEMO_PAYER.address;
export const DEMO_MERCHANT_ADDRESS = process.env.X402_MERCHANT_ADDRESS ?? DEMO_PAYER.address;
export const DEMO_RESOURCE_DESCRIPTION = "Kaspa x402 premium content";
// The current TN12 facilitator demo uses a single-input shape with a live fee
// around 100_000 sompi, so smaller outputs are intentionally avoided here.
export const DEMO_AMOUNT_SOMPI = 10_000_000;
export const DEMO_MAX_FEE_SOMPI = 200_000;
export const FACILITATOR_FIXED_FEE_SOMPI = 500;
export const DEMO_PAYER_UTXO_AMOUNT_SOMPI = 15_000;

export function buildDemoPaymentRequirements(overrides = {}) {
  return createKaspaExactPaymentRequirements({
    merchantAddress: DEMO_MERCHANT_ADDRESS,
    amountSompi: DEMO_AMOUNT_SOMPI,
    maxFeeSompi: DEMO_MAX_FEE_SOMPI,
    ...overrides
  });
}

export function buildDemoPaymentRequired({
  resourceUrl = PREMIUM_RESOURCE_URL,
  resourceDescription = DEMO_RESOURCE_DESCRIPTION,
  resourceMimeType = "text/plain; charset=utf-8",
  paymentId,
  ...requirementOverrides
} = {}) {
  return createPaymentRequired({
    resource: {
      url: resourceUrl,
      description: resourceDescription,
      mimeType: resourceMimeType
    },
    paymentRequirements: buildDemoPaymentRequirements(requirementOverrides),
    paymentId
  });
}

export const buildDemoRequirement = buildDemoPaymentRequirements;
