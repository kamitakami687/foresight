import {
  erc20Abi,
  formatUnits,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { ARC_CONFIG } from "./arc.js";

// Arc Testnet Gateway Wallet / domain (see Circle Gateway testnet reference).
export const GATEWAY_WALLET_ADDRESS: Address = "0x0077777d7EBA4688BDeF3E311b846F25870A19B9";
const GATEWAY_API_BASE = "https://gateway-api-testnet.circle.com/v1";
const ARC_TESTNET_GATEWAY_DOMAIN = 26;

const gatewayWalletAbi = [
  {
    type: "function",
    name: "deposit",
    inputs: [
      { name: "token", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export async function getUsdcBalance(
  publicClient: PublicClient,
  address: Address
): Promise<bigint> {
  return publicClient.readContract({
    address: ARC_CONFIG.usdcErc20Address as Address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [address],
  });
}

// Sending USDC to the Gateway Wallet with a plain ERC-20 transfer does NOT
// credit the unified balance — it must go through deposit().
export async function depositToGateway(
  walletClient: WalletClient,
  publicClient: PublicClient,
  amountUsdc: string
): Promise<Hex> {
  const account = walletClient.account;
  if (!account) {
    throw new Error("Wallet client has no connected account");
  }

  const value = parseUnits(amountUsdc, 6);
  const usdcAddress = ARC_CONFIG.usdcErc20Address as Address;

  const approvalTx = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: usdcAddress,
    abi: erc20Abi,
    functionName: "approve",
    args: [GATEWAY_WALLET_ADDRESS, value],
  });
  await publicClient.waitForTransactionReceipt({ hash: approvalTx });

  const depositTx = await walletClient.writeContract({
    account,
    chain: walletClient.chain,
    address: GATEWAY_WALLET_ADDRESS,
    abi: gatewayWalletAbi,
    functionName: "deposit",
    args: [usdcAddress, value],
  });
  await publicClient.waitForTransactionReceipt({ hash: depositTx });

  return depositTx;
}

export async function queryGatewayBalance(depositor: Address): Promise<string> {
  const res = await fetch(`${GATEWAY_API_BASE}/balances`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: "USDC",
      sources: [{ domain: ARC_TESTNET_GATEWAY_DOMAIN, depositor }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Gateway balance query failed: ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    balances: { domain: number; depositor: string; balance: string }[];
  };
  return data.balances[0]?.balance ?? "0";
}

export function formatUsdc(value: bigint): string {
  return formatUnits(value, 6);
}
