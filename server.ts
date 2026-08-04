import "dotenv/config";
import express from "express";
import cors from "cors";
import { predictRouter } from "./server/predict.js";
import { validateRouter } from "./server/validate.js";

const app = express();

// PAYMENT-REQUIRED / PAYMENT-RESPONSE must be exposed or browser fetch()
// can't read them (default CORS only exposes a small header safelist).
app.use(
  cors({
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
  })
);
app.use(express.json());
app.use(predictRouter);
app.use(validateRouter);

// Vercel's Express detector requires a literal `import express from
// "express"` in this exact file (root-level app/index/server.ts) to
// recognize the project as Express and deploy it as a single Function —
// see packages/frameworks/src/frameworks.ts in vercel/vercel. Re-exporting
// from server/app.ts (as this file used to do) doesn't satisfy that check.
export default app;
