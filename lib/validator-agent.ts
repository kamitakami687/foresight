import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { getMarketBySlug, type GammaEvent } from "./polymarket.js";

const REPUTATION_REGISTRY_ADDRESS = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const BLOCKCHAIN = "ARC-TESTNET";
const ZERO_BYTES32 = `0x${"00".repeat(32)}`;

// A closed market's outcomePrices should already be exactly ["1","0"] or
// ["0","1"] once fully settled. A price still sitting near 0.5 despite
// being closed means resolution hasn't actually landed yet (still
// mid-settlement, or a data glitch) — distinct from "pending" (not
// closed yet at all).
const AMBIGUOUS_BAND = 0.05;

export type ResolutionResult =
  | { status: "pending" }
  | { status: "ambiguous" }
  | { status: "resolved"; match: boolean; actualOutcome: "up" | "down" };

export function determineResolution(
  market: GammaEvent,
  predictedOutcome: "up" | "down"
): ResolutionResult {
  if (!market.closed) {
    return { status: "pending" };
  }

  const submarket = market.markets[0];
  const outcomes = JSON.parse(submarket.outcomes) as string[];
  const outcomePrices = JSON.parse(submarket.outcomePrices) as string[];

  const upIndex = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const upPrice = Number(outcomePrices[upIndex]);

  if (Math.abs(upPrice - 0.5) < AMBIGUOUS_BAND) {
    return { status: "ambiguous" };
  }

  const actualOutcome: "up" | "down" = upPrice > 0.5 ? "up" : "down";
  return { status: "resolved", match: actualOutcome === predictedOutcome, actualOutcome };
}

export async function checkOutcome(
  slug: string,
  predictedOutcome: "up" | "down"
): Promise<ResolutionResult> {
  const market = await getMarketBySlug(slug);
  if (!market) {
    throw new Error(`No market found for slug "${slug}"`);
  }
  return determineResolution(market, predictedOutcome);
}

export function feedbackFor(match: boolean): { value: number; tag1: string } {
  return match
    ? { value: 100, tag1: "prediction_correct" }
    : { value: 20, tag1: "prediction_incorrect" };
}

// Submitted by the REPORTER wallet, never the VALIDATOR itself — ERC-8004
// forbids an agent scoring its own performance.
export async function giveFeedback(match: boolean): Promise<{ txHash: string }> {
  const reporterAddress = process.env.REPORTER_WALLET_ADDRESS;
  const agentId = process.env.VALIDATOR_AGENT_ID;
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!reporterAddress) throw new Error("Missing REPORTER_WALLET_ADDRESS in .env");
  if (!agentId) throw new Error("Missing VALIDATOR_AGENT_ID in .env");
  if (!apiKey || !entitySecret) {
    throw new Error("Missing CIRCLE_API_KEY or CIRCLE_ENTITY_SECRET in .env");
  }

  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
  const { value, tag1 } = feedbackFor(match);

  const txRes = await client.createContractExecutionTransaction({
    walletAddress: reporterAddress,
    blockchain: BLOCKCHAIN,
    contractAddress: REPUTATION_REGISTRY_ADDRESS,
    abiFunctionSignature: "giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)",
    abiParameters: [agentId, value, 0, tag1, "", "", "", ZERO_BYTES32],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });

  const tx = await client.getTransaction({ id: txRes.data!.id, waitForState: "COMPLETE" });
  const txHash = tx.data?.transaction?.txHash;
  if (!txHash) {
    throw new Error(`Feedback transaction ${txRes.data!.id} reached COMPLETE but no txHash was returned`);
  }

  return { txHash };
}
