import { Router } from "express";
import { createGatewayMiddleware } from "@circle-fin/x402-batching/server";
import type { PaymentRequest } from "@circle-fin/x402-batching/server";
import {
  ASSETS,
  DURATIONS,
  listActiveMarkets,
  type AssetKey,
  type DurationKey,
} from "../lib/polymarket.js";
import { detectAsset, predictOutcome } from "../lib/analyst-agent.js";
import { sweepToEscrow } from "../scripts/sweep-to-escrow.js";

const sellerAddress = process.env.X402_SELLER_ADDRESS as `0x${string}`;
if (!sellerAddress) {
  throw new Error("Missing X402_SELLER_ADDRESS in .env");
}

// Arc Testnet only, for now — matches lib/arc.ts / ARC_CONFIG.chainId (5042002)
const gateway = createGatewayMiddleware({
  sellerAddress,
  networks: ["eip155:5042002"],
  facilitatorUrl: "https://gateway-api-testnet.circle.com",
  description: "PolyPredict hourly market prediction",
});

export const predictRouter = Router();

function isAssetKey(value: unknown): value is AssetKey {
  return typeof value === "string" && value in ASSETS;
}

function isDurationKey(value: unknown): value is DurationKey {
  return typeof value === "string" && value in DURATIONS;
}

predictRouter.post("/predict", gateway.require("$0.01"), async (req, res) => {
  const payment = (req as unknown as PaymentRequest).payment;
  const { marketInput, assetKey: assetKeyFromClient, duration } = req.body as {
    marketInput?: string;
    assetKey?: string;
    duration?: string;
  };

  // Don't blindly trust the client's pre-computed assetKey — fall back to
  // detecting it from marketInput ourselves if it's missing or invalid.
  const assetKey = isAssetKey(assetKeyFromClient)
    ? assetKeyFromClient
    : typeof marketInput === "string"
      ? detectAsset(marketInput)
      : null;

  if (!isAssetKey(assetKey)) {
    res.status(400).json({
      error: `Unrecognized or missing assetKey: ${assetKeyFromClient} (also failed to detect an asset from marketInput: ${marketInput})`,
    });
    return;
  }
  if (!isDurationKey(duration)) {
    res.status(400).json({ error: `Unrecognized or missing duration: ${duration}` });
    return;
  }

  try {
    const events = await listActiveMarkets(assetKey, duration);
    // Prefer the event whose slug the user actually pasted; otherwise fall
    // back to the soonest one to resolve (listActiveMarkets orders by
    // endDate ascending).
    const target =
      events.find(
        (event) =>
          typeof marketInput === "string" &&
          marketInput.toLowerCase().includes(event.slug.toLowerCase())
      ) ?? events[0];

    if (!target) {
      res.status(404).json({ error: `No active ${duration} market found for ${assetKey}` });
      return;
    }

    // Both Date.now() and new Date(isoString).getTime() are UTC epoch
    // milliseconds — timezone-agnostic regardless of server or visitor locale.
    const minutesUntilClose = (new Date(target.endDate).getTime() - Date.now()) / 60000;

    const { outcome, confidence, rationale, signalData } = await predictOutcome(
      assetKey,
      duration,
      target
    );

    res.json({
      outcome,
      confidence,
      rationale,
      signalData,
      minutesUntilClose,
      market: { slug: target.slug, title: target.title, endDate: target.endDate },
      payment,
    });

    // Sweep after the response is already sent — on-chain settlement
    // shouldn't add latency to the client's prediction result. Failure
    // here is logged, not surfaced to the client: they already got a
    // valid prediction for a payment that settled correctly.
    if (payment) {
      console.log(
        `Payment receipt: payer=${payment.payer} amount=${payment.amount} network=${payment.network} tx=${payment.transaction ?? "n/a"}`
      );
      try {
        const { txHash, transferId } = await sweepToEscrow();
        console.log(`Swept ${payment.amount} to escrow: txHash=${txHash} transferId=${transferId ?? "n/a"}`);
      } catch (err) {
        console.error(`Sweep to escrow failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
