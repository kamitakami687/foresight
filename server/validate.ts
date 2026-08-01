import { Router } from "express";
import { checkOutcome, giveFeedback } from "../lib/validator-agent.js";
import { computeStats, recordResolution } from "../lib/history.js";
import { refundUser } from "../scripts/refund-user.js";

export const validateRouter = Router();

function isOutcome(value: unknown): value is "up" | "down" {
  return value === "up" || value === "down";
}

validateRouter.post("/validate", async (req, res) => {
  const { slug, predictedOutcome, userAddress } = req.body as {
    slug?: string;
    predictedOutcome?: string;
    userAddress?: string;
  };

  if (typeof slug !== "string" || !slug) {
    res.status(400).json({ error: "Missing or invalid slug" });
    return;
  }
  if (!isOutcome(predictedOutcome)) {
    res.status(400).json({ error: `Unrecognized or missing predictedOutcome: ${predictedOutcome}` });
    return;
  }
  if (typeof userAddress !== "string" || !userAddress) {
    res.status(400).json({ error: "Missing or invalid userAddress" });
    return;
  }

  try {
    const resolution = await checkOutcome(slug, predictedOutcome);

    if (resolution.status === "pending" || resolution.status === "ambiguous") {
      res.json({ status: resolution.status });
      return;
    }

    // resolution.status === "resolved" from here on.
    try {
      recordResolution(slug, resolution.actualOutcome);
    } catch (err) {
      console.error(
        `History resolution record failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if (resolution.match) {
      const { txHash: reputationTxHash } = await giveFeedback(true);
      res.json({
        status: "resolved",
        match: true,
        actualOutcome: resolution.actualOutcome,
        refunded: false,
        reputationTxHash,
      });
      return;
    }

    const { txHash } = await refundUser(userAddress);
    const { txHash: reputationTxHash } = await giveFeedback(false);
    res.json({
      status: "resolved",
      match: false,
      actualOutcome: resolution.actualOutcome,
      refunded: true,
      refundTxHash: txHash,
      reputationTxHash,
    });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Honest track record: total predictions, resolved count, overall
// win-rate, per-duration win-rates, and win-rate per confidence bucket.
validateRouter.get("/stats", (_req, res) => {
  try {
    res.json(computeStats());
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
