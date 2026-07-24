import type { Address, Hex, WalletClient } from "viem";

export interface GatewayPaymentRequirements {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: {
    name?: string;
    version?: string;
    verifyingContract?: Address;
  };
}

export interface GatewayPaymentPayload {
  signature: Hex;
  authorization: {
    from: Address;
    to: Address;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: Hex;
  };
}

// Mirrors @circle-fin/x402-batching's client/BatchEvmScheme.ts signing logic
// (verified against the installed package source), adapted to take a
// browser-connected wagmi WalletClient instead of a raw private-key signer.
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function randomNonce(): Hex {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `0x${Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")}` as Hex;
}

export async function signGatewayPayment(
  walletClient: WalletClient,
  paymentRequirements: GatewayPaymentRequirements
): Promise<GatewayPaymentPayload> {
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet client has no connected account");
  }
  if (!paymentRequirements.network.startsWith("eip155:")) {
    throw new Error(
      `Unsupported network format: "${paymentRequirements.network}". Expected "eip155:<chainId>"`
    );
  }
  const verifyingContract = paymentRequirements.extra?.verifyingContract;
  if (!verifyingContract) {
    throw new Error(
      "paymentRequirements.extra.verifyingContract is missing (GatewayWallet address)"
    );
  }

  const chainId = parseInt(paymentRequirements.network.split(":")[1], 10);
  const from = account.address;
  const to = paymentRequirements.payTo as Address;
  const value = BigInt(paymentRequirements.amount);
  const now = Math.floor(Date.now() / 1000);
  const validAfter = BigInt(now - 600);
  const validBefore = BigInt(now + paymentRequirements.maxTimeoutSeconds);
  const nonce = randomNonce();

  const domain = {
    name: "GatewayWalletBatched",
    version: "1",
    chainId,
    verifyingContract,
  } as const;

  const signature = await walletClient.signTypedData({
    account,
    domain,
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { from, to, value, validAfter, validBefore, nonce },
  });

  return {
    signature,
    authorization: {
      from,
      to,
      value: value.toString(),
      validAfter: validAfter.toString(),
      validBefore: validBefore.toString(),
      nonce,
    },
  };
}
