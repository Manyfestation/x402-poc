import path from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_KASPA_WASM_SDK_ROOT = path.resolve(__dirname, "../../../.local/kaspa-wasm32-sdk");

export const DEFAULT_KASPA_WASM_SDK_ROOT =
  process.env.X402_KASPA_WASM_SDK_ROOT ?? DEFAULT_REPO_KASPA_WASM_SDK_ROOT;
export const DEFAULT_KASPA_WASM_SDK_FLAVOR =
  process.env.X402_KASPA_WASM_SDK_FLAVOR ?? "kaspa-dev";
export const DEFAULT_PAYER_MNEMONIC =
  process.env.X402_PAYER_MNEMONIC ?? "know sense day erosion fork subway reflect define exhaust example upset sibling";
export const DEFAULT_MERCHANT_MNEMONIC =
  process.env.X402_MERCHANT_MNEMONIC ??
  "hunt bitter praise lift buyer topic crane leopard uniform network inquiry over grain pass match crush marine strike doll relax fortune trumpet sunny silk";

const DEFAULT_HTTP_TIMEOUT_MS = toPositiveInteger(process.env.X402_HTTP_TIMEOUT_MS, 25_000);

let cachedKaspaNode;

function toPositiveInteger(rawValue, fallbackValue) {
  const parsed = Number(rawValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallbackValue;
}

export function getKaspaSdkRoot() {
  return DEFAULT_KASPA_WASM_SDK_ROOT;
}

export function getKaspaBrowserSdkDir() {
  return path.join(getKaspaSdkRoot(), "web", DEFAULT_KASPA_WASM_SDK_FLAVOR);
}

export function getKaspaSdkFlavor() {
  return DEFAULT_KASPA_WASM_SDK_FLAVOR;
}

export function getHttpTimeoutMs() {
  return DEFAULT_HTTP_TIMEOUT_MS;
}

export function assertKaspaSdkAvailable() {
  const sdkRoot = getKaspaSdkRoot();
  const nodeEntry = path.join(sdkRoot, "nodejs", DEFAULT_KASPA_WASM_SDK_FLAVOR, "kaspa.js");
  const browserEntry = path.join(sdkRoot, "web", DEFAULT_KASPA_WASM_SDK_FLAVOR, "kaspa.js");

  if (!existsSync(nodeEntry) || !existsSync(browserEntry)) {
    throw new Error(
      `Kaspa WASM SDK not found at ${sdkRoot}. Set X402_KASPA_WASM_SDK_ROOT to the extracted kaspa-wasm32-sdk folder.`
    );
  }

  return sdkRoot;
}

export function toKaspaNetworkId(network) {
  if (typeof network !== "string" || !network) {
    throw new Error("network is required");
  }

  return network.startsWith("kaspa:") ? network.slice("kaspa:".length) : network;
}

export async function loadKaspaNode() {
  if (!cachedKaspaNode) {
    assertKaspaSdkAvailable();
    cachedKaspaNode = require(path.join(getKaspaSdkRoot(), "nodejs", DEFAULT_KASPA_WASM_SDK_FLAVOR));
    if (typeof cachedKaspaNode.initConsolePanicHook === "function") {
      cachedKaspaNode.initConsolePanicHook();
    }
  }

  return cachedKaspaNode;
}

function derivePrivateKey({ kaspa, mnemonic, networkId, receiveIndex = 0 }) {
  const phrase = mnemonic ?? DEFAULT_PAYER_MNEMONIC;
  const mnemonicValue = new kaspa.Mnemonic(phrase);
  const xprv = new kaspa.XPrv(mnemonicValue.toSeed());
  const keygen = new kaspa.PrivateKeyGenerator(xprv, false, 0n);
  const privateKey = keygen.receiveKey(receiveIndex);
  return {
    mnemonic: phrase,
    networkId,
    privateKey,
    address: privateKey.toAddress(networkId).toString()
  };
}

function extractPskbInputAddresses(displayFormat) {
  const inputAddresses = [];
  let inInputSection = false;

  for (const rawLine of displayFormat.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("Input #")) {
      inInputSection = true;
      continue;
    }

    if (line.startsWith("Output #")) {
      inInputSection = false;
      continue;
    }

    if (!inInputSection) {
      continue;
    }

    const match = line.match(/^address:\s*(\S+)$/);
    if (match) {
      inputAddresses.push(match[1]);
    }
  }

  return [...new Set(inputAddresses)];
}

function parseSompiAmount(rawValue) {
  const value = rawValue.trim();
  const decimalMatch = value.match(/(-?[\d,_.]+)\s*([A-Za-z]+)/);
  if (decimalMatch) {
    const normalizedNumber = decimalMatch[1].replaceAll(",", "").replaceAll("_", "");
    const unit = decimalMatch[2].toUpperCase();
    if (unit === "KAS" || unit === "TKAS") {
      const [wholePart, fractionalPart = ""] = normalizedNumber.split(".");
      const whole = Number(wholePart || "0");
      const fractional = Number((fractionalPart + "00000000").slice(0, 8));
      const sign = normalizedNumber.startsWith("-") ? -1 : 1;
      const amount = sign * ((Math.abs(whole) * 100_000_000) + fractional);
      if (!Number.isSafeInteger(amount)) {
        throw new Error(`invalid sompi amount "${rawValue}"`);
      }
      return amount;
    }
  }

  const integerMatch = value.match(/-?[\d,_]+/);
  if (!integerMatch) {
    throw new Error(`could not parse sompi amount from "${rawValue}"`);
  }

  const normalized = integerMatch[0].replaceAll(",", "").replaceAll("_", "");
  const amount = Number(normalized);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`invalid sompi amount "${rawValue}"`);
  }

  return amount;
}

function extractPskbOutputs(displayFormat) {
  const outputs = [];
  let currentOutput = null;

  function pushCurrentOutput() {
    if (!currentOutput) {
      return;
    }

    if (!currentOutput.address) {
      throw new Error("PSKB output is missing an address");
    }

    if (!Number.isInteger(currentOutput.amountSompi)) {
      throw new Error("PSKB output is missing an amount");
    }

    outputs.push(currentOutput);
    currentOutput = null;
  }

  for (const rawLine of displayFormat.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("Output #")) {
      pushCurrentOutput();
      currentOutput = { address: null, amountSompi: null };
      continue;
    }

    if (line.startsWith("Input #")) {
      pushCurrentOutput();
      currentOutput = null;
      continue;
    }

    if (!currentOutput) {
      continue;
    }

    let match = line.match(/^address:\s*(\S+)$/);
    if (match) {
      currentOutput.address = match[1];
      continue;
    }

    match = line.match(/^(?:amount|value):\s*(.+)$/);
    if (match) {
      currentOutput.amountSompi = parseSompiAmount(match[1]);
    }
  }

  pushCurrentOutput();
  return outputs;
}

function inspectUnsignedPskbDisplay(displayFormat, { requirement, signingSummary }) {
  if (!requirement || typeof requirement !== "object") {
    throw new Error("requirement is required");
  }

  if (!signingSummary || typeof signingSummary !== "object") {
    throw new Error("signingSummary is required");
  }

  const outputs = extractPskbOutputs(displayFormat);
  if (outputs.length === 0) {
    throw new Error("PSKB did not expose any outputs");
  }

  const merchantOutputs = outputs.filter((output) => output.address === requirement.merchantAddress);
  if (merchantOutputs.length === 0) {
    throw new Error("PSKB is missing the merchant output");
  }

  const merchantAmountSompi = merchantOutputs.reduce((total, output) => total + output.amountSompi, 0);
  if (merchantAmountSompi !== requirement.amountSompi) {
    throw new Error("PSKB merchant output amount mismatch");
  }

  if (merchantAmountSompi !== signingSummary.transferAmountSompi) {
    throw new Error("PSKB merchant output does not match the signing summary");
  }

  const changeOutputs = outputs.filter((output) => output.address !== requirement.merchantAddress);
  if (changeOutputs.length > 1) {
    throw new Error("PSKB produced an unsupported change shape for this demo");
  }

  if (changeOutputs.length === 0) {
    if (signingSummary.changeAmountSompi !== 0) {
      throw new Error("PSKB change output is missing");
    }
  } else {
    const [changeOutput] = changeOutputs;
    if (changeOutput.address !== signingSummary.changeAddress) {
      throw new Error("PSKB change output address mismatch");
    }
    if (changeOutput.amountSompi !== signingSummary.changeAmountSompi) {
      throw new Error("PSKB change output amount mismatch");
    }
  }

  const totalOutputSompi = outputs.reduce((total, output) => total + output.amountSompi, 0);
  if (totalOutputSompi !== signingSummary.transferAmountSompi + signingSummary.changeAmountSompi) {
    throw new Error("PSKB output totals do not match the signing summary");
  }

  return {
    outputs,
    merchantAmountSompi,
    changeOutputs
  };
}

function deriveMatchingPrivateKeys({ kaspa, mnemonic, networkId, addresses, searchLimit = 128 }) {
  const remaining = new Set(addresses);
  const phrase = mnemonic ?? DEFAULT_PAYER_MNEMONIC;
  const mnemonicValue = new kaspa.Mnemonic(phrase);
  const xprv = new kaspa.XPrv(mnemonicValue.toSeed());
  const keygen = new kaspa.PrivateKeyGenerator(xprv, false, 0n);
  const privateKeys = [];

  for (let index = 0; index < searchLimit && remaining.size > 0; index += 1) {
    const receiveKey = keygen.receiveKey(index);
    const receiveAddress = receiveKey.toAddress(networkId).toString();
    if (remaining.has(receiveAddress)) {
      privateKeys.push({
        address: receiveAddress,
        privateKey: receiveKey
      });
      remaining.delete(receiveAddress);
    }

    if (remaining.size === 0) {
      break;
    }

    const changeKey = keygen.changeKey(index);
    const changeAddress = changeKey.toAddress(networkId).toString();
    if (remaining.has(changeAddress)) {
      privateKeys.push({
        address: changeAddress,
        privateKey: changeKey
      });
      remaining.delete(changeAddress);
    }
  }

  if (remaining.size > 0) {
    throw new Error(`could not derive signing key(s) for ${[...remaining].join(", ")}`);
  }

  return privateKeys;
}

async function signPskbWithKeypairAccount({ kaspa, networkId, pskb, privateKeyHex, signForAddress }) {
  const walletSecret = "x402-local-pskb-sign";
  const wallet = new kaspa.Wallet({
    resident: true,
    networkId
  });

  await wallet.start();

  try {
    await wallet.walletCreate({
      walletSecret,
      title: "x402-local-pskb-sign",
      filename: `x402-local-pskb-sign-${randomUUID()}`,
      overwriteWalletStorage: true
    });

    const { prvKeyDataId } = await wallet.prvKeyDataCreate({
      walletSecret,
      secretKey: privateKeyHex,
      kind: "secretKey"
    });

    const { accountDescriptor } = await wallet.accountsCreate({
      walletSecret,
      type: "kaspa-keypair-standard",
      accountName: "x402-local-pskb-sign",
      prvKeyDataId
    });

    const { pskb: signedPskb } = await wallet.accountsPskbSign({
      accountId: accountDescriptor.accountId,
      walletSecret,
      pskb,
      signForAddress
    });

    return signedPskb;
  } finally {
    await wallet.stop().catch(() => {});
  }
}

async function signPskbLocally({ kaspa, unsignedTransaction, mnemonic, networkId }) {
  const pskb = kaspa.PSKB.deserialize(unsignedTransaction);
  const inputAddresses = extractPskbInputAddresses(pskb.displayFormat(networkId));
  if (inputAddresses.length === 0) {
    throw new Error("PSKB did not expose any input addresses to sign");
  }

  const privateKeys = deriveMatchingPrivateKeys({
    kaspa,
    mnemonic,
    networkId,
    addresses: inputAddresses
  });

  let signedPskb = unsignedTransaction;
  for (const entry of privateKeys) {
    signedPskb = await signPskbWithKeypairAccount({
      kaspa,
      networkId,
      pskb: signedPskb,
      privateKeyHex: entry.privateKey.toString(),
      signForAddress: entry.address
    });
  }

  return signedPskb;
}

export async function deriveAddressFromMnemonic({
  mnemonic = DEFAULT_PAYER_MNEMONIC,
  network,
  receiveIndex = 0
} = {}) {
  const kaspa = await loadKaspaNode();
  const networkId = toKaspaNetworkId(network);
  const wallet = derivePrivateKey({ kaspa, mnemonic, networkId, receiveIndex });
  return {
    mnemonic,
    networkId,
    address: wallet.address
  };
}

export async function deriveAddressCandidatesFromMnemonic({
  mnemonic = DEFAULT_PAYER_MNEMONIC,
  network,
  limit = 8
} = {}) {
  const kaspa = await loadKaspaNode();
  const networkId = toKaspaNetworkId(network);
  const phrase = mnemonic ?? DEFAULT_PAYER_MNEMONIC;
  const mnemonicValue = new kaspa.Mnemonic(phrase);
  const xprv = new kaspa.XPrv(mnemonicValue.toSeed());
  const keygen = new kaspa.PrivateKeyGenerator(xprv, false, 0n);
  const addresses = [];

  for (let index = 0; index < limit; index += 1) {
    addresses.push(keygen.receiveKey(index).toAddress(networkId).toString());
    addresses.push(keygen.changeKey(index).toAddress(networkId).toString());
  }

  return {
    mnemonic: phrase,
    networkId,
    addresses
  };
}

export async function signUnsignedTransaction({
  unsignedTransaction,
  mnemonic = DEFAULT_PAYER_MNEMONIC,
  network
}) {
  if (!unsignedTransaction || typeof unsignedTransaction !== "string") {
    throw new Error("unsignedTransaction is required");
  }

  if (!unsignedTransaction.startsWith("PSKB")) {
    throw new Error("only PSKB unsigned transactions are supported in the active TN12 flow");
  }

  const kaspa = await loadKaspaNode();
  const networkId = toKaspaNetworkId(network);
  const wallet = derivePrivateKey({ kaspa, mnemonic, networkId });
  const signedTransaction = await signPskbLocally({
    kaspa,
    unsignedTransaction,
    mnemonic,
    networkId
  });

  return {
    signedTransaction,
    payerAddress: wallet.address
  };
}

export async function inspectUnsignedTransaction({
  unsignedTransaction,
  network,
  requirement,
  signingSummary
}) {
  if (!unsignedTransaction || typeof unsignedTransaction !== "string") {
    throw new Error("unsignedTransaction is required");
  }

  if (!unsignedTransaction.startsWith("PSKB")) {
    throw new Error("only PSKB unsigned transactions are supported in the active TN12 flow");
  }

  const kaspa = await loadKaspaNode();
  const networkId = toKaspaNetworkId(network);
  const pskb = kaspa.PSKB.deserialize(unsignedTransaction);
  const displayFormat = pskb.displayFormat(networkId);
  const inputAddresses = extractPskbInputAddresses(displayFormat);
  const inspection = inspectUnsignedPskbDisplay(displayFormat, {
    requirement,
    signingSummary
  });

  return {
    inputAddresses,
    outputs: inspection.outputs,
    merchantAmountSompi: inspection.merchantAmountSompi,
    changeOutputs: inspection.changeOutputs
  };
}
