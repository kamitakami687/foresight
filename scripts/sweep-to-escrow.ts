import "dotenv/config";
import { AppKit } from "@circle-fin/app-kit";
import { createViemAdapterFromPrivateKey } from "@circle-fin/adapter-viem-v2";
import type { Hex } from "viem";

// The fixed $0.01 prediction fee, swept in full from the self-custodied
// X402_SELLER wallet's Gateway balance to the Circle-managed escrow
// wallet after each successful paid prediction. Nanopayments settlement
// and Unified Balance Kit share the same underlying Circle Gateway
// account per address (same GatewayWallet contract, same depositor-keyed
// balance, same gateway-api-testnet.circle.com API) — verified directly
// against both packages' source, not assumed.
const SWEEP_AMOUNT_USDC = "0.01";

const kit = new AppKit();

export interface SweepResult {
  txHash: string;
  transferId?: string;
  explorerUrl?: string;
}

export async function sweepToEscrow(): Promise<SweepResult> {
  const privateKey = process.env.X402_SELLER_PRIVATE_KEY as Hex | undefined;
  const escrowAddress = process.env.ESCROW_WALLET_ADDRESS;
  if (!privateKey) {
    throw new Error("Missing X402_SELLER_PRIVATE_KEY in .env");
  }
  if (!escrowAddress) {
    throw new Error("Missing ESCROW_WALLET_ADDRESS in .env");
  }

  const adapter = createViemAdapterFromPrivateKey({ privateKey });

  // Forwarding Service: ESCROW_WALLET_ADDRESS is Circle-managed — we
  // don't hold a signing key for it, so recipientAddress + useForwarder
  // lets Circle's infrastructure submit the destination mint itself. No
  // destination adapter (and no second signing setup) needed at all.
  const result = await kit.unifiedBalance.spend({
    from: {
      adapter,
      allocations: { amount: SWEEP_AMOUNT_USDC, chain: "Arc_Testnet" },
    },
    to: {
      chain: "Arc_Testnet",
      recipientAddress: escrowAddress,
      useForwarder: true,
    },
    amount: SWEEP_AMOUNT_USDC,
  });

  return {
    txHash: result.txHash,
    transferId: result.transferId,
    explorerUrl: result.explorerUrl,
  };
}
