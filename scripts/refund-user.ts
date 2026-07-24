import "dotenv/config";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { ARC_CONFIG } from "../lib/arc.js";

const REFUND_AMOUNT_USDC = "0.009"; // 90% of the $0.01 prediction fee
const ESCROW_BLOCKCHAIN = "ARC-TESTNET";

function getClient() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env");
  }
  return initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

export async function refundUser(userAddress: string): Promise<{ txHash: string }> {
  const escrowAddress = process.env.ESCROW_WALLET_ADDRESS;
  if (!escrowAddress) {
    throw new Error("Missing ESCROW_WALLET_ADDRESS in .env");
  }

  const client = getClient();

  // Matches dev-controlled-projects/send-assets.ts's proven-working shape:
  // walletAddress + blockchain, not walletId — the walletId branch of
  // createTransaction's input type rejects with a bare "API parameter
  // invalid" against the live API despite type-checking cleanly.
  const transferResponse = await client.createTransaction({
    walletAddress: escrowAddress,
    blockchain: ESCROW_BLOCKCHAIN,
    tokenAddress: ARC_CONFIG.usdcErc20Address,
    destinationAddress: userAddress,
    amount: [REFUND_AMOUNT_USDC],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });

  const transactionId = transferResponse.data?.id;
  if (!transactionId) {
    throw new Error("createTransaction did not return a transaction id");
  }

  const txResponse = await client.getTransaction({
    id: transactionId,
    waitForState: "COMPLETE",
  });

  const txHash = txResponse.data?.transaction?.txHash;
  if (!txHash) {
    throw new Error(`Refund transaction ${transactionId} reached COMPLETE but no txHash was returned`);
  }

  return { txHash };
}
