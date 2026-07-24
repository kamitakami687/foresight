import { useCallback, useEffect, useState } from "react";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWalletClient,
} from "wagmi";
import { injected } from "wagmi/connectors";
import { signGatewayPayment } from "../lib/gateway-signer.js";
import type { GatewayPaymentRequirements } from "../lib/gateway-signer.js";
import { detectAsset } from "../lib/analyst-agent.js";
import type { DurationKey } from "../lib/polymarket.js";
import {
  depositToGateway,
  getUsdcBalance,
  queryGatewayBalance,
} from "../lib/gateway-deposit.js";

const API_BASE = "http://localhost:3001";

const DURATION_BUTTONS: { key: DurationKey; label: string }[] = [
  { key: "5m", label: "5 Min" },
  { key: "15m", label: "15 Min" },
  { key: "1h", label: "1 Hour" },
  { key: "4h", label: "4 Hour" },
];

type Status =
  | "idle"
  | "requesting"
  | "awaiting-signature"
  | "paying"
  | "done"
  | "error";

interface PredictionResult {
  outcome?: "up" | "down" | string;
  confidence?: number;
  rationale?: string;
  signalData?: unknown;
  minutesUntilClose?: number;
  [key: string]: unknown;
}

interface PredictionEntry {
  status: Status;
  error: string | null;
  result: PredictionResult | null;
  detailsOpen: boolean;
}

function emptyEntry(): PredictionEntry {
  return { status: "idle", error: null, result: null, detailsOpen: false };
}

interface PaymentResource {
  url: string;
  description: string;
  mimeType: string;
}

interface PaymentRequired {
  x402Version: number;
  resource: PaymentResource;
  accepts: GatewayPaymentRequirements[];
}

function decodeBase64Json<T>(value: string): T {
  return JSON.parse(atob(value)) as T;
}

const BUSY_STATUSES: Status[] = ["requesting", "awaiting-signature", "paying"];

const STATUS_MESSAGES: Partial<Record<Status, string>> = {
  requesting: "Requesting payment terms...",
  "awaiting-signature": "Confirm payment in your wallet...",
  paying: "Submitting payment...",
};

type DepositStatus = "idle" | "checking" | "insufficient" | "pending" | "done" | "error";

export function App() {
  const { address, isConnected } = useAccount();
  const { connect } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();

  const [marketInput, setMarketInput] = useState("");
  const [predictions, setPredictions] = useState<
    Record<DurationKey, PredictionEntry>
  >({
    "5m": emptyEntry(),
    "15m": emptyEntry(),
    "1h": emptyEntry(),
    "4h": emptyEntry(),
  });

  const [depositAmount, setDepositAmount] = useState("1");
  const [depositStatus, setDepositStatus] = useState<DepositStatus>("idle");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [gatewayBalance, setGatewayBalance] = useState<string | null>(null);

  const canSubmit = marketInput.trim().length > 0;

  const refreshGatewayBalance = useCallback(async () => {
    if (!address) return;
    try {
      const balance = await queryGatewayBalance(address);
      setGatewayBalance(balance);
    } catch {
      // Leave the last-known balance displayed rather than clobbering it
      // on a transient query failure.
    }
  }, [address]);

  useEffect(() => {
    if (isConnected && address) {
      refreshGatewayBalance();
    }
  }, [isConnected, address, refreshGatewayBalance]);

  async function handleDeposit() {
    if (!walletClient || !address || !publicClient) {
      setDepositStatus("error");
      setDepositError("Connect a wallet first");
      return;
    }

    const requestedAmount = Number(depositAmount);
    if (!Number.isFinite(requestedAmount) || requestedAmount <= 0) {
      setDepositStatus("error");
      setDepositError("Enter a valid deposit amount");
      return;
    }

    setDepositStatus("checking");
    setDepositError(null);

    try {
      const requestedValue = BigInt(Math.round(requestedAmount * 1_000_000));
      const usdcBalance = await getUsdcBalance(publicClient, address);

      if (usdcBalance < requestedValue) {
        setDepositStatus("insufficient");
        return;
      }

      setDepositStatus("pending");
      await depositToGateway(walletClient, publicClient, depositAmount);

      setDepositStatus("done");
      await refreshGatewayBalance();
    } catch (err) {
      setDepositStatus("error");
      setDepositError(err instanceof Error ? err.message : String(err));
    }
  }

  function updateEntry(duration: DurationKey, patch: Partial<PredictionEntry>) {
    setPredictions((prev) => ({
      ...prev,
      [duration]: { ...prev[duration], ...patch },
    }));
  }

  function toggleDetails(duration: DurationKey) {
    setPredictions((prev) => ({
      ...prev,
      [duration]: { ...prev[duration], detailsOpen: !prev[duration].detailsOpen },
    }));
  }

  async function handlePredict(duration: DurationKey) {
    if (!walletClient || !address) {
      updateEntry(duration, { status: "error", error: "Connect a wallet first" });
      return;
    }

    updateEntry(duration, {
      status: "requesting",
      error: null,
      result: null,
      detailsOpen: false,
    });

    // detectAsset() matches on known asset names (bitcoin, ethereum); if
    // the pasted text is a market URL/slug it won't match, so we fall
    // back to passing the raw input through and let the server resolve it.
    const assetKey = detectAsset(marketInput);
    const requestBody = { marketInput, assetKey, duration };

    try {
      // Step 1: request without payment, expect 402 with requirements
      const firstResponse = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (firstResponse.status !== 402) {
        throw new Error(
          `Expected 402 Payment Required, got ${firstResponse.status}`
        );
      }

      const paymentRequiredHeader = firstResponse.headers.get(
        "PAYMENT-REQUIRED"
      );
      if (!paymentRequiredHeader) {
        throw new Error("402 response missing PAYMENT-REQUIRED header");
      }

      const paymentRequired = decodeBase64Json<PaymentRequired>(
        paymentRequiredHeader
      );
      const requirements = paymentRequired.accepts.find((r) =>
        r.network.startsWith("eip155:")
      );
      if (!requirements) {
        throw new Error("No usable payment requirements in 402 response");
      }

      // Step 2: sign the EIP-712 authorization with the connected wallet
      updateEntry(duration, { status: "awaiting-signature" });
      const paymentPayload = await signGatewayPayment(
        walletClient,
        requirements
      );

      // Step 3: retry with the signed payment attached
      updateEntry(duration, { status: "paying" });
      const paymentSignatureHeader = btoa(
        JSON.stringify({
          x402Version: paymentRequired.x402Version,
          resource: paymentRequired.resource,
          accepted: requirements,
          payload: paymentPayload,
        })
      );

      const secondResponse = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "payment-signature": paymentSignatureHeader,
        },
        body: JSON.stringify(requestBody),
      });

      if (!secondResponse.ok) {
        const body = await secondResponse.text();
        throw new Error(`Payment failed (${secondResponse.status}): ${body}`);
      }

      const data = (await secondResponse.json()) as PredictionResult;
      updateEntry(duration, { status: "done", result: data });
    } catch (err) {
      updateEntry(duration, {
        status: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div>
      <h1>PolyPredict</h1>

      {!isConnected ? (
        <button onClick={() => connect({ connector: injected() })}>
          Connect Wallet
        </button>
      ) : (
        <div>
          <p>Connected: {address}</p>
          <button onClick={() => disconnect()}>Disconnect</button>
        </div>
      )}

      <input
        type="text"
        value={marketInput}
        onChange={(e) => setMarketInput(e.target.value)}
        placeholder="Paste a Polymarket URL (e.g. bitcoin-up-or-down-july-16-2026-11pm-et)"
        style={{ width: "28rem", maxWidth: "90%", padding: "0.5rem", marginTop: "2rem" }}
      />

      <div style={{ display: "flex", gap: "1.5rem", marginTop: "1.5rem", marginLeft: "1.5rem" }}>
        {DURATION_BUTTONS.map(({ key, label }) => {
          const entry = predictions[key];
          const isBusy = BUSY_STATUSES.includes(entry.status);
          const outcome = entry.result?.outcome
            ? String(entry.result.outcome).toUpperCase()
            : "";

          return (
            <div key={key} style={{ display: "flex", flexDirection: "column", width: "14rem" }}>
              <button onClick={() => handlePredict(key)} disabled={!canSubmit || isBusy}>
                {isBusy ? `${label}...` : label}
              </button>

              <div style={{ display: "flex", flexDirection: "row", alignItems: "flex-start", gap: "0.5rem", marginTop: "0.5rem" }}>
                <span style={{ fontSize: "0.8rem", fontWeight: "bold", whiteSpace: "nowrap", marginTop: "0.5rem" }}>
                  RESULT:
                </span>

                <div
                  style={{
                    flex: 1,
                    minHeight: "6rem",
                    border: "1px solid #ccc",
                    borderRadius: "4px",
                    padding: "0.5rem",
                  }}
                >
                  {entry.status === "idle" && null}

                  {isBusy && (
                    <p style={{ fontSize: "0.8rem" }}>{STATUS_MESSAGES[entry.status]}</p>
                  )}

                  {entry.status === "error" && (
                    <p style={{ fontSize: "0.8rem", color: "red" }}>{entry.error}</p>
                  )}

                  {entry.status === "done" && entry.result && (
                    <div>
                      <p
                        style={{
                          fontWeight: "bold",
                          fontSize: "1.2rem",
                          color: outcome === "UP" ? "green" : outcome === "DOWN" ? "red" : undefined,
                        }}
                      >
                        {outcome}
                      </p>
                      {entry.result.confidence !== undefined && (
                        <p style={{ fontSize: "0.8rem" }}>
                          Confidence: {entry.result.confidence}
                        </p>
                      )}
                      {entry.result.minutesUntilClose !== undefined && (
                        <p style={{ fontSize: "0.75rem", color: "#666" }}>
                          Resolves in {Math.round(entry.result.minutesUntilClose)} min
                        </p>
                      )}
                      <button
                        style={{ fontSize: "0.75rem" }}
                        onClick={() => toggleDetails(key)}
                      >
                        {entry.detailsOpen ? "Hide details" : "View details"}
                      </button>
                      {entry.detailsOpen && (
                        <div style={{ marginTop: "0.5rem" }}>
                          {entry.result.rationale && (
                            <p style={{ fontSize: "0.75rem" }}>{entry.result.rationale}</p>
                          )}
                          <pre style={{ fontSize: "0.7rem" }}>
                            {JSON.stringify(entry.result.signalData ?? entry.result, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div
        style={{
          marginTop: "2.5rem",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span style={{ fontWeight: "bold" }}>AMOUNT:</span>
          <input
            type="number"
            min="0"
            step="0.01"
            value={depositAmount}
            onChange={(e) => setDepositAmount(e.target.value)}
            style={{ width: "6rem", padding: "0.4rem" }}
          />
          <button
            onClick={handleDeposit}
            disabled={!isConnected || depositStatus === "checking" || depositStatus === "pending"}
          >
            {depositStatus === "pending" ? "Confirm deposit in your wallet..." : "Deposit"}
          </button>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.5rem" }}>
          <span style={{ fontWeight: "bold" }}>GATEWAY BALANCE:</span>
          <input
            type="text"
            readOnly
            disabled
            value={gatewayBalance !== null ? `${gatewayBalance} USDC` : "—"}
            style={{ width: "6rem", padding: "0.4rem" }}
          />
        </div>

        {depositStatus === "insufficient" && (
          <p style={{ fontSize: "0.8rem", color: "red" }}>
            Not enough USDC in your wallet. Get testnet USDC from{" "}
            <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
              faucet.circle.com
            </a>
            .
          </p>
        )}

        {depositStatus === "error" && depositError && (
          <p style={{ fontSize: "0.8rem", color: "red" }}>{depositError}</p>
        )}
      </div>
    </div>
  );
}
