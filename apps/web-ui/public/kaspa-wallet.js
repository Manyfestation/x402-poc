import * as kaspa from "/vendor/kaspa/kaspa.js";

let kaspaReady;

async function loadKaspa() {
  if (!kaspaReady) {
    kaspaReady = kaspa.default("/vendor/kaspa/kaspa_bg.wasm").then(() => kaspa);
  }

  return kaspaReady;
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

function deriveMatchingPrivateKeys({ sdk, mnemonic, networkId, addresses, searchLimit = 128 }) {
  const remaining = new Set(addresses);
  const mnemonicValue = new sdk.Mnemonic(mnemonic);
  const xprv = new sdk.XPrv(mnemonicValue.toSeed());
  const keygen = new sdk.PrivateKeyGenerator(xprv, false, 0n);
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

async function signPskbWithKeypairAccount({ sdk, networkId, pskb, privateKeyHex, signForAddress }) {
  const walletSecret = "x402-local-pskb-sign";
  const wallet = new sdk.Wallet({
    resident: true,
    networkId
  });

  await wallet.start();

  try {
    await wallet.walletCreate({
      walletSecret,
      title: "x402-local-pskb-sign",
      filename: `x402-local-pskb-sign-${crypto.randomUUID()}`,
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

async function signPskbLocally({ sdk, unsignedTransaction, mnemonic, networkId }) {
  const pskb = sdk.PSKB.deserialize(unsignedTransaction);
  const inputAddresses = extractPskbInputAddresses(pskb.displayFormat(networkId));
  if (inputAddresses.length === 0) {
    throw new Error("PSKB did not expose any input addresses to sign");
  }

  const privateKeys = deriveMatchingPrivateKeys({
    sdk,
    mnemonic,
    networkId,
    addresses: inputAddresses
  });

  let signedPskb = unsignedTransaction;
  for (const entry of privateKeys) {
    signedPskb = await signPskbWithKeypairAccount({
      sdk,
      networkId,
      pskb: signedPskb,
      privateKeyHex: entry.privateKey.toString(),
      signForAddress: entry.address
    });
  }

  return signedPskb;
}

export async function signQuoteTransaction({ unsignedTransaction, mnemonic, networkId }) {
  if (!unsignedTransaction || typeof unsignedTransaction !== "string") {
    throw new Error("unsignedTransaction is required");
  }

  if (!mnemonic || typeof mnemonic !== "string") {
    throw new Error("mnemonic is required");
  }

  if (!unsignedTransaction.startsWith("PSKB")) {
    throw new Error("only PSKB unsigned transactions are supported in the active TN12 flow");
  }

  const sdk = await loadKaspa();
  return {
    signedTransaction: await signPskbLocally({
      sdk,
      unsignedTransaction,
      mnemonic,
      networkId
    })
  };
}

export async function inspectQuoteTransaction({ unsignedTransaction, networkId, requirement, signingSummary }) {
  if (!unsignedTransaction || typeof unsignedTransaction !== "string") {
    throw new Error("unsignedTransaction is required");
  }

  if (!unsignedTransaction.startsWith("PSKB")) {
    throw new Error("only PSKB unsigned transactions are supported in the active TN12 flow");
  }

  const sdk = await loadKaspa();
  const pskb = sdk.PSKB.deserialize(unsignedTransaction);
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

export async function deriveAddressCandidates({ mnemonic, networkId, limit = 8 }) {
  if (!mnemonic || typeof mnemonic !== "string") {
    throw new Error("mnemonic is required");
  }

  const sdk = await loadKaspa();
  const mnemonicValue = new sdk.Mnemonic(mnemonic);
  const xprv = new sdk.XPrv(mnemonicValue.toSeed());
  const keygen = new sdk.PrivateKeyGenerator(xprv, false, 0n);
  const addresses = [];

  for (let index = 0; index < limit; index += 1) {
    addresses.push(keygen.receiveKey(index).toAddress(networkId).toString());
    addresses.push(keygen.changeKey(index).toAddress(networkId).toString());
  }

  return addresses;
}
