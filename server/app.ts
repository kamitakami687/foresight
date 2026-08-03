import "dotenv/config";
import express from "express";
import cors from "cors";
import { predictRouter } from "./predict.js";
import { validateRouter } from "./validate.js";

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

export default app;
