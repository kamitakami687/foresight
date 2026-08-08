import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, formatUnits, http } from "viem";
import { arcChain, ARC_CONFIG } from "../lib/arc.js";
import { signGatewayPayment } from "../lib/gateway-signer.js";
import type { GatewayPaymentRequirements } from "../lib/gateway-signer.js";
import { detectAsset } from "../lib/analyst-agent.js";
import type { DurationKey } from "../lib/polymarket.js";
import {
  depositToGateway,
  getUsdcBalance,
  queryGatewayBalance,
} from "../lib/gateway-deposit.js";
import eyeUrl from "./foresight-eye-transparent.png";

// Minimal EIP-1193 shape for the legacy window.ethereum fallback (the
// EIP-6963 store above is the primary source; window.ethereum is only used
// when no wallet supports EIP-6963 — single-wallet browsers, like AnchorPay).
declare global {
  interface Window {
    ethereum?: {
      request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    };
  }
}

const API_BASE = "/api";

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
  market?: { slug: string; title: string; endDate: string };
  [key: string]: unknown;
}

type CheckStatus = "idle" | "checking" | "pending" | "resolved" | "ambiguous" | "error";

interface CheckResult {
  match: boolean;
  actualOutcome: "up" | "down";
  refunded: boolean;
  refundTxHash?: string;
  reputationTxHash?: string;
}

interface PredictionStats {
  total: number;
  resolved: number;
  overallWinRate: number | null;
  byDuration: Record<string, { count: number; correct: number; winRate: number | null }>;
  byBucket: { bucket: string; count: number; correct: number; winRate: number | null }[];
}

interface PredictionEntry {
  status: Status;
  error: string | null;
  result: PredictionResult | null;
  detailsOpen: boolean;
  checkStatus: CheckStatus;
  checkResult: CheckResult | null;
  checkError: string | null;
}

function emptyEntry(): PredictionEntry {
  return {
    status: "idle",
    error: null,
    result: null,
    detailsOpen: false,
    checkStatus: "idle",
    checkResult: null,
    checkError: null,
  };
}

const ARCSCAN_TX_BASE = "https://testnet.arcscan.app/tx/";

function formatRemaining(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
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

function shortenAddress(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function rpcErrorCode(err: unknown): number | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  const code = (e?.code ?? e?.cause?.code) as unknown;
  return typeof code === "number" ? code : undefined;
}

// Raw EIP-6963 wallet store (the same pattern as the working AnchorPay dapp):
// every wallet announces { info, provider } and we keep the RAW provider
// object, so connect and the Arc switch go through the chosen wallet's own
// provider — no wagmi connector wrapper in the path.
type WalletDetail = {
  info: { uuid: string; name: string; icon?: string; rdns?: string };
  provider: {
    request(args: { method: string; params?: unknown[] }): Promise<unknown>;
    on?(event: string, fn: (...a: unknown[]) => void): void;
    removeListener?(event: string, fn: (...a: unknown[]) => void): void;
  };
};

const walletsStore = (() => {
  let wallets: WalletDetail[] = [];
  const listeners = new Set<() => void>();
  window.addEventListener("eip6963:announceProvider", (e) => {
    const { info, provider } = (e as CustomEvent).detail as {
      info: WalletDetail["info"];
      provider: WalletDetail["provider"];
    };
    if (!wallets.some((w) => w.info.uuid === info.uuid)) {
      wallets = [...wallets, { info, provider }];
      listeners.forEach((l) => l());
    }
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return {
    subscribe(l: () => void) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    getWallets: () => wallets,
  };
})();

function useWallets(): WalletDetail[] {
  const [wallets, setWallets] = useState(walletsStore.getWallets());
  useEffect(
    () =>
      walletsStore.subscribe(() => {
        setWallets(walletsStore.getWallets());
      }),
    []
  );
  return wallets;
}

export function App() {
  const [wallet, setWallet] = useState<{
    address: `0x${string}`;
    chainId: number;
    provider: WalletDetail["provider"];
  } | null>(null);
  const wallets = useWallets();
  const address = wallet?.address ?? null;
  const chainId = wallet?.chainId ?? null;
  const isConnected = !!wallet;
  const provider = wallet?.provider ?? null;
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);

  // Soft hint shown when the wallet isn't on Arc Testnet (auto-switch
  // rejected by the user or unsupported by the wallet).
  const [chainHint, setChainHint] = useState<string | null>(null);
  // Wallet chooser (EIP-6963): open when several wallets are installed.
  const [walletPickerOpen, setWalletPickerOpen] = useState(false);
  // Page view: only one section renders at a time; header/footer persist.
  const [view, setView] = useState<"home" | "about" | "how" | "faucet">("home");

  // Diagnostic: dump every discovered wallet at page load AND whenever
  // EIP-6963 discovery adds a new one — proves the list is dynamic.
  useEffect(() => {
    console.info(
      "[wallets]",
      wallets.map((w) => ({ name: w.info.name, rdns: w.info.rdns, uuid: w.info.uuid }))
    );
  }, [wallets]);

  // Follow the connected provider's events (accountsChanged / chainChanged /
  // disconnect) to keep the UI reactive without wagmi.
  useEffect(() => {
    if (!provider) return;
    const onAccounts = (accs: unknown) =>
      setWallet((w) =>
        w
          ? { ...w, address: ((accs as string[])[0] ?? "") as `0x${string}` }
          : w
      );
    const onChain = (c: unknown) =>
      setWallet((w) => (w ? { ...w, chainId: Number(c) } : w));
    const onDisconnect = () => setWallet(null);
    provider.on?.("accountsChanged", onAccounts);
    provider.on?.("chainChanged", onChain);
    provider.on?.("disconnect", onDisconnect);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
      provider.removeListener?.("disconnect", onDisconnect);
    };
  }, [provider]);

  // viem clients — the same WalletClient/PublicClient wagmi used to provide.
  const walletClient = useMemo(
    () =>
      address && provider
        ? createWalletClient({
            account: address as `0x${string}`,
            chain: arcChain,
            transport: custom(provider as never),
          })
        : undefined,
    [address, provider]
  );
  const publicClient = useMemo(
    () =>
      createPublicClient({
        chain: arcChain,
        transport: http(arcChain.rpcUrls.default.http[0]),
      }),
    []
  );

  const disconnect = useCallback(() => setWallet(null), []);

  // Wallet USDC balance on Arc (like ArcShift): shown next to the address.
  useEffect(() => {
    let cancelled = false;
    if (!address) {
      setUsdcBalance(null);
      return;
    }
    getUsdcBalance(publicClient, address as `0x${string}`)
      .then((b) => {
        if (!cancelled) setUsdcBalance(formatUnits(b, ARC_CONFIG.usdcErc20Decimals));
      })
      .catch(() => {
        if (!cancelled) setUsdcBalance(null);
      });
    return () => {
      cancelled = true;
    };
  }, [address, publicClient]);

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

  // Calibration history — honest win-rates by duration and confidence.
  const [stats, setStats] = useState<PredictionStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/stats`);
        if (!res.ok) throw new Error(`stats ${res.status}`);
        const data = (await res.json()) as PredictionStats;
        if (!cancelled) {
          setStats(data);
          setStatsError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setStatsError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Single app-wide tick driving every column's live countdown — one
  // interval instead of one per duration card.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

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

  // ----- Connect + Arc auto-switch, exactly like the working Arc dapps ----
  // (AnchorPay): the RAW EIP-6963 provider the chosen wallet announced does
  // eth_requestAccounts and wallet_switchEthereumChain itself — no wagmi, no
  // connector wrapper, no window.ethereum. 4902 (chain not added yet) falls
  // back to wallet_addEthereumChain with arcChain's official params.
  async function connectWithConnector(w: WalletDetail) {
    const p = w.provider;
    console.info("[ArcChain] connecting with wallet:", w.info.name);
    try {
      const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
      if (!accounts?.[0]) {
        console.warn("[ArcChain] no accounts returned");
        return;
      }
      try {
        await p.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: `0x${arcChain.id.toString(16)}` }],
        });
      } catch (err) {
        if (rpcErrorCode(err) === 4902) {
          await p.request({
            method: "wallet_addEthereumChain",
            params: [
              {
                chainId: `0x${arcChain.id.toString(16)}`,
                chainName: arcChain.name,
                nativeCurrency: arcChain.nativeCurrency,
                rpcUrls: [arcChain.rpcUrls.default.http[0]],
                blockExplorerUrls: [arcChain.blockExplorers?.default?.url].filter(Boolean),
              },
            ],
          });
        }
      }
      const chain = Number(await p.request({ method: "eth_chainId" }));
      setWallet({ address: accounts[0] as `0x${string}`, chainId: chain, provider: p });
      setChainHint(null);
    } catch (err) {
      console.warn("[ArcChain] connect failed:", err);
    }
  }

  // EIP-6963-discovered wallets: every wallet that announced itself
  // (MetaMask, Rabby, Coinbase, OKX, Phantom, ...) is selectable — dynamic,
  // no hardcoding, new wallets appear automatically.
  const walletOptions = wallets;

  async function handleConnectClick() {
    console.info("[ArcChain] Connect clicked");
    // No EIP-6963 wallet at all -> legacy fallback to window.ethereum
    // (single-wallet browsers), exactly like AnchorPay.
    if (wallets.length === 0 && window.ethereum) {
      await connectWithConnector({
        info: { uuid: "legacy", name: "Injected Wallet", rdns: undefined },
        provider: window.ethereum as unknown as WalletDetail["provider"],
      });
      return;
    }
    // Wallet chooser: a single detected wallet connects straight away;
    // several wallets -> the picker lists exactly the discovered ones
    // (name/icon from EIP-6963 metadata), and the Arc auto-switch targets
    // the wallet the user picked.
    if (walletOptions.length === 1) {
      await connectWithConnector(walletOptions[0]);
    } else {
      setWalletPickerOpen(true);
    }
  }

  // Guarantee the wallet is on Arc Testnet before any on-chain write.
  // Returns true when it is safe to proceed. Used by deposit and predict.
  async function ensureArcForTx(): Promise<boolean> {
    if (chainId === arcChain.id) return true;
    if (!provider) return false;
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: `0x${arcChain.id.toString(16)}` }],
      });
      return true;
    } catch (err) {
      if (rpcErrorCode(err) === 4902) {
        await provider.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: `0x${arcChain.id.toString(16)}`,
              chainName: arcChain.name,
              nativeCurrency: arcChain.nativeCurrency,
              rpcUrls: [arcChain.rpcUrls.default.http[0]],
              blockExplorerUrls: [arcChain.blockExplorers?.default?.url].filter(Boolean),
            },
          ],
        });
        return true;
      }
      setChainHint(
        `Wrong network: chain ${chainId ?? "unknown"}, expected Arc Testnet (${arcChain.id}).`
      );
      return false;
    }
  }

  async function handleDeposit() {
    if (!isConnected || !address || !publicClient) {
      setDepositStatus("error");
      setDepositError("Connect a wallet first");
      return;
    }

    // Switch the wallet to Arc Testnet FIRST — the wallet client is created
    // for Arc, and the payment flow assumes the wallet is on Arc.
    const onArc = await ensureArcForTx();
    if (!onArc) {
      setDepositStatus("error");
      setDepositError(
        "Deposit requires Arc Testnet — approve the network switch in your wallet."
      );
      return;
    }

    const client = walletClient;
    if (!client) {
      setDepositStatus("error");
      setDepositError("Wallet client not ready, reconnect your wallet");
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
      await depositToGateway(client, publicClient, depositAmount);

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
    if (!isConnected || !address) {
      updateEntry(duration, { status: "error", error: "Connect a wallet first" });
      return;
    }

    // Same guarantee as deposit: the x402 signature and payment flow assume
    // Arc Testnet. Ensure the wallet is on Arc before proceeding.
    const onArc = await ensureArcForTx();
    if (!onArc) {
      updateEntry(duration, {
        status: "error",
        error: "Predictions require Arc Testnet — approve the network switch in your wallet.",
      });
      return;
    }

    const client = walletClient;
    if (!client) {
      updateEntry(duration, {
        status: "error",
        error: "Wallet client not ready, reconnect your wallet",
      });
      return;
    }

    updateEntry(duration, {
      status: "requesting",
      error: null,
      result: null,
      detailsOpen: false,
      checkStatus: "idle",
      checkResult: null,
      checkError: null,
    });

    const assetKey = detectAsset(marketInput);
    const requestBody = { marketInput, assetKey, duration };

    try {
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

      updateEntry(duration, { status: "awaiting-signature" });
      const paymentPayload = await signGatewayPayment(
        client,
        requirements
      );

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

  async function handleCheckOutcome(duration: DurationKey) {
    const entry = predictions[duration];
    const slug = entry.result?.market?.slug;
    const predictedOutcome = entry.result?.outcome;

    if (!address || !slug || !predictedOutcome) {
      updateEntry(duration, {
        checkStatus: "error",
        checkError: "Missing data needed to check this outcome",
      });
      return;
    }

    updateEntry(duration, { checkStatus: "checking", checkError: null });

    try {
      const response = await fetch(`${API_BASE}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slug,
          predictedOutcome: String(predictedOutcome).toLowerCase(),
          userAddress: address,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Validate failed (${response.status}): ${body}`);
      }

      const data = (await response.json()) as {
        status: "pending" | "ambiguous" | "resolved";
        match?: boolean;
        actualOutcome?: "up" | "down";
        refunded?: boolean;
        refundTxHash?: string;
        reputationTxHash?: string;
      };

      if (data.status === "pending" || data.status === "ambiguous") {
        updateEntry(duration, { checkStatus: data.status });
        return;
      }

      updateEntry(duration, {
        checkStatus: "resolved",
        checkResult: {
          match: data.match!,
          actualOutcome: data.actualOutcome!,
          refunded: data.refunded!,
          refundTxHash: data.refundTxHash,
          reputationTxHash: data.reputationTxHash,
        },
      });
    } catch (err) {
      updateEntry(duration, {
        checkStatus: "error",
        checkError: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className="app">
      {/* Moving-averages background: generated inline SVG, palette-only colors. */}
      <div className="bg-chart" aria-hidden="true">
        <svg viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="bg-fade" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0b1e33" />
              <stop offset="100%" stopColor="#000000" />
            </linearGradient>
          </defs>
          <rect width="1440" height="900" fill="url(#bg-fade)" />
        </svg>
      </div>

      <header className="header">
        <div className="header-left">
          <img src={eyeUrl} alt="Foresight" className="header-logo" />
          <span className="logo">Foresight</span>
          <span className="logo-sub">AI Powered Prediction Markets</span>
          <nav className="header-nav">
            <button
              className={`nav-link ${view === "home" ? "nav-link-active" : ""}`}
              onClick={() => setView("home")}
            >
              Home
            </button>
            <button
              className={`nav-link ${view === "about" ? "nav-link-active" : ""}`}
              onClick={() => setView("about")}
            >
              About
            </button>
            <button
              className={`nav-link ${view === "how" ? "nav-link-active" : ""}`}
              onClick={() => setView("how")}
            >
              How It Works
            </button>
            <button
              className={`nav-link ${view === "faucet" ? "nav-link-active" : ""}`}
              onClick={() => setView("faucet")}
            >
              Faucet
            </button>
          </nav>
        </div>

        <div className="header-right">
          {!isConnected ? (
            <button className="btn-connect" onClick={handleConnectClick}>
              Connect Wallet
            </button>
          ) : (
            <div className="wallet-group">
              <div className="wallet-capsule" title="Connected wallet">
                {usdcBalance && (
                  <span className="wallet-capsule-balance">USDC {usdcBalance}</span>
                )}
                <span className="wallet-capsule-address">{shortenAddress(address!)}</span>
              </div>
              <span
                className={`chain-badge ${
                  chainId === arcChain.id ? "chain-badge-ok" : "chain-badge-warn"
                }`}
                title={`Wallet chain: ${chainId ?? "unknown"}`}
              >
                {chainId === arcChain.id
                  ? "Arc Testnet"
                  : chainId
                    ? `Chain ${chainId}`
                    : "Chain …"}
              </span>
              <button
                className="wallet-disconnect"
                onClick={() => disconnect()}
                title="Disconnect"
                aria-label="Disconnect"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                  <line x1="12" y1="2" x2="12" y2="12" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </header>

      {chainHint && (
        <div className="chain-hint" role="status">
          {chainHint}
        </div>
      )}

      {walletPickerOpen && (
        <div className="wallet-picker-overlay" onClick={() => setWalletPickerOpen(false)}>
          <div className="wallet-picker" onClick={(e) => e.stopPropagation()}>
            <h3 className="wallet-picker-title">Connect a wallet</h3>
            {walletOptions.length === 0 && (
              <p className="wallet-picker-empty">No wallet detected</p>
            )}
            {walletOptions.map((w) => (
              <button
                key={w.info.uuid}
                className="wallet-picker-item"
                onClick={() => {
                  setWalletPickerOpen(false);
                  void connectWithConnector(w);
                }}
              >
                {w.info.icon ? (
                  <img src={w.info.icon} alt="" className="wallet-picker-icon" />
                ) : (
                  <span className="wallet-picker-icon wallet-picker-icon-fallback">🔗</span>
                )}
                <span>{w.info.name}</span>
              </button>
            ))}
            <button className="wallet-picker-cancel" onClick={() => setWalletPickerOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {view === "about" && (
        <main className="main">
          <div className="info-page">
            <h2>About</h2>
            <p>
              Foresight is a live prediction app built on Arc Testnet. It
              currently supports 5 min, 15 min, 1 hour and 4 hour predictions
              for BTC and ETH.
            </p>
            <p>
              Ask a question like "Bitcoin up or down?" or paste a Polymarket
              link, pick a timeframe, and pay $0.01. The Prediction agent pulls
              live Binance candlestick data and the Polymarket order book, and
              returns a directional call with a confidence level and its
              reasoning.
            </p>
            <p>
              Three agents handle the cycle. The agent holds a real onchain
              identity registered under ERC-8004 on Arc Testnet. The
              Prediction agent produces the forecast; once the market resolves
              and you press Check outcome, the Validator agent compares the
              forecast against what actually happened. The Reporter agent then
              writes that verdict to the ERC-8004 ReputationRegistry and, when
              the forecast was wrong, sends an automatic 90% refund of 0.009
              USDC.
            </p>
            <p>
              Instant payments run on USDC through Circle Nanopayments, with
              USDC as the native gas token on Arc.
            </p>
            <p>
              Every verified prediction gets a permanent onchain log entry,
              correct and incorrect alike.
            </p>
            <h2>How the track record works</h2>
            <p>
              Foresight's track record is not stored on our servers. It is read
              directly from the agent's ERC-8004 reputation on Arc, so it
              cannot be edited, reset, or lost when the app redeploys.
            </p>
            <p>
              A prediction only enters the track record after you press Check
              outcome and the result is written on chain. That is why resolved
              always equals predictions: only resolved predictions are
              recorded. Refresh the page to see updated numbers.
            </p>
            <div className="info-highlights">
              <div className="info-highlight">
                Gasless USDC payments via Circle Nanopayments
              </div>
              <div className="info-highlight">
                Onchain agent identity and reputation via ERC-8004
              </div>
              <div className="info-highlight">
                Live data from Binance and the Polymarket order book
              </div>
              <div className="info-highlight">
                Automatic 90% refund on wrong predictions
              </div>
            </div>
            <p className="info-note">
              Built on Arc Testnet. More supported assets planned.
            </p>
          </div>
        </main>
      )}

      {view === "how" && (
        <main className="main">
          <div className="info-page">
            <h2>How It Works</h2>
            <ol>
              <li>Connect your browser wallet.</li>
              <li>Deposit USDC to the Gateway.</li>
              <li>
                Paste a Polymarket link, or type a question like "Bitcoin up or
                down?".
              </li>
              <li>Press a timeframe: 5 min, 15 min, 1 hr or 4 hr.</li>
              <li>
                Pay $0.01. The agent analyses live market data and returns a
                prediction with its reasoning.
              </li>
              <li>
                Wait for the timer to expire. The Check outcome button then
                appears.
              </li>
              <li>
                Press Check outcome. The Validator agent checks whether the
                prediction was right.
              </li>
              <li>
                If it was wrong, you automatically get 90% back (0.009 USDC).
              </li>
              <li>
                Every validated prediction, right or wrong, gets a permanent
                onchain log entry.
              </li>
            </ol>
          </div>
        </main>
      )}

      {view === "faucet" && (
        <main className="main">
          <div className="info-page">
            <h2>Faucet</h2>
            <p>You need testnet USDC to use Foresight</p>
            <a
              className="btn btn-connect"
              href="https://faucet.circle.com/"
              target="_blank"
              rel="noopener noreferrer"
            >
              CLAIM TESTNET USDC
            </a>
          </div>
        </main>
      )}

      {view === "home" && (
        <>
      <main className="main">
        {/* Market Input */}
        <section className="market-section">
          <label className="market-label">Market URL</label>
          <div className="market-input-wrapper">
            <input
              type="text"
              className="market-input"
              value={marketInput}
              onChange={(e) => setMarketInput(e.target.value)}
              placeholder="Enter your question or market URL to begin"
            />
          </div>
        </section>

        {/* Prediction Cards */}
        <div className="prediction-grid">
          {DURATION_BUTTONS.map(({ key, label }) => {
            const entry = predictions[key];
            const isBusy = BUSY_STATUSES.includes(entry.status);
            const outcome = entry.result?.outcome
              ? String(entry.result.outcome).toUpperCase()
              : "";

            const endDateMs = entry.result?.market?.endDate
              ? new Date(entry.result.market.endDate).getTime()
              : null;
            const remainingMs = endDateMs !== null ? endDateMs - now : null;
            const closePassed = remainingMs !== null && remainingMs <= 0;

            return (
              <div key={key} className="prediction-card">
                <div className="prediction-card-header">
                  <span className="prediction-card-title">{label}</span>
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handlePredict(key)}
                    disabled={!canSubmit || isBusy}
                  >
                    {isBusy ? "..." : "Predict"}
                  </button>
                </div>

                <div className="prediction-card-body">
                  {entry.status === "idle" && (
                    <span className="status-idle">Enter a market URL to begin</span>
                  )}

                  {isBusy && (
                    <div className="status-busy">
                      <div className="spinner" />
                      <span className="status-message">{STATUS_MESSAGES[entry.status]}</span>
                    </div>
                  )}

                  {entry.status === "error" && (
                    <span className="status-error">{entry.error}</span>
                  )}

                  {entry.status === "done" && entry.result && (
                    <>
                      <span
                        className={`outcome ${
                          outcome === "UP"
                            ? "outcome-up"
                            : outcome === "DOWN"
                            ? "outcome-down"
                            : "outcome-neutral"
                        }`}
                      >
                        {outcome || "—"}
                      </span>

                      <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                        {entry.result.confidence !== undefined && (
                          <span className="confidence-badge">
                            {Math.round(entry.result.confidence * 100)}%
                          </span>
                        )}
                      </div>

                      {remainingMs !== null && !closePassed && (
                        <span className="resolves-in">
                          Resolves in {formatRemaining(remainingMs)}
                        </span>
                      )}

                      {closePassed &&
                        entry.checkStatus !== "resolved" &&
                        entry.checkStatus !== "ambiguous" && (
                          <div className="check-outcome-block">
                            {entry.checkStatus === "pending" && (
                              <p className="check-outcome-message">
                                Market still resolving, check back shortly
                              </p>
                            )}
                            {entry.checkStatus === "error" && entry.checkError && (
                              <p className="check-outcome-message check-outcome-message-error">
                                {entry.checkError}
                              </p>
                            )}
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => handleCheckOutcome(key)}
                              disabled={entry.checkStatus === "checking"}
                            >
                              {entry.checkStatus === "checking" ? "Checking..." : "Check Outcome"}
                            </button>
                          </div>
                        )}

                      {entry.checkStatus === "resolved" && entry.checkResult && (
                        entry.checkResult.match ? (
                          <p className="check-outcome-result check-outcome-correct">
                            ✓ Correct — fee kept
                          </p>
                        ) : (
                          <div className="check-outcome-result check-outcome-wrong">
                            <p>✗ Wrong — 0.009 USDC refunded</p>
                            {entry.checkResult.refundTxHash && (
                              <a
                                href={`${ARCSCAN_TX_BASE}${entry.checkResult.refundTxHash}`}
                                target="_blank"
                                rel="noreferrer"
                                className="arcscan-link"
                              >
                                View refund tx on Arcscan
                              </a>
                            )}
                          </div>
                        )
                      )}

                      {entry.checkStatus === "ambiguous" && (
                        <p className="check-outcome-result check-outcome-ambiguous">
                          Market resolved too close to call, no refund applies
                        </p>
                      )}

                      <button
                        className="details-toggle"
                        onClick={() => toggleDetails(key)}
                      >
                        {entry.detailsOpen ? "Hide details" : "View details"}
                      </button>

                      {entry.detailsOpen && (
                        <div className="details-content">
                          {entry.result.rationale && (
                            <p>{entry.result.rationale}</p>
                          )}
                          <pre>
                            {JSON.stringify(entry.result.signalData ?? entry.result, null, 2)}
                          </pre>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Deposit Section */}
        <section className="deposit-section">
          <div className="deposit-section-title">Gateway</div>

          <div className="deposit-row">
            <span className="deposit-label">AMOUNT</span>
            <input
              type="number"
              className="deposit-input"
              min="0"
              step="0.01"
              value={depositAmount}
              onChange={(e) => setDepositAmount(e.target.value)}
              disabled={depositStatus === "pending" || depositStatus === "checking"}
            />
            <button
              className="btn btn-primary"
              onClick={handleDeposit}
              disabled={!isConnected || depositStatus === "checking" || depositStatus === "pending"}
            >
              {depositStatus === "checking"
                ? "Checking..."
                : depositStatus === "pending"
                ? "Confirm..."
                : "Deposit"}
            </button>
          </div>

          <div className="deposit-balance">
            <span className="balance-label">GATEWAY BALANCE</span>
            <span className="balance-value">
              {gatewayBalance !== null ? `${gatewayBalance} USDC` : "—"}
            </span>
          </div>

          {depositStatus === "insufficient" && (
            <p className="deposit-message deposit-message-warn">
              Not enough USDC in your wallet. Get testnet USDC from{" "}
              <a href="https://faucet.circle.com/" target="_blank" rel="noreferrer">
                faucet.circle.com
              </a>
              .
            </p>
          )}

          {depositStatus === "error" && depositError && (
            <p className="deposit-message deposit-message-error">{depositError}</p>
          )}

          {depositStatus === "done" && (
            <p className="deposit-message" style={{ color: "var(--accent-green)" }}>
              Deposit successful
            </p>
          )}
        </section>
      </main>

      <section className="stats-panel">
        <h2>Track record</h2>
        {statsError && <p className="stats-muted">Stats unavailable: {statsError}</p>}
        {!statsError && !stats && <p className="stats-muted">Loading stats…</p>}
        {stats && (
          <>
            <div className="stats-grid">
              <div className="stat-cell">
                <span className="stat-value">{stats.total}</span>
                <span className="stat-label">predictions</span>
              </div>
              <div className="stat-cell">
                <span className="stat-value">
                  {stats.total > 0 ? `${stats.resolved}/${stats.total}` : "—"}
                </span>
                <span className="stat-label">resolved</span>
              </div>
              <div className="stat-cell">
                <span className="stat-value">
                  {stats.overallWinRate !== null
                    ? `${Math.round(stats.overallWinRate * 100)}%`
                    : "—"}
                </span>
                <span className="stat-label">overall accuracy</span>
              </div>
            </div>

            {stats.total > 0 &&
              (Object.keys(stats.byDuration).length > 0 || stats.byBucket.length > 0) && (
              <>
                <h3>By duration</h3>
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>Duration</th>
                      <th>Count</th>
                      <th>Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(stats.byDuration).map(([duration, d]) => (
                      <tr key={duration}>
                        <td>{duration}</td>
                        <td>{d.count}</td>
                        <td>
                          {d.winRate !== null ? `${Math.round(d.winRate * 100)}%` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                <h3>By confidence</h3>
                <table className="stats-table">
                  <thead>
                    <tr>
                      <th>Confidence</th>
                      <th>Count</th>
                      <th>Win rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.byBucket
                      .filter((b) => b.count > 0)
                      .map((b) => (
                        <tr key={b.bucket}>
                          <td>{b.bucket}</td>
                          <td>{b.count}</td>
                          <td>{b.winRate !== null ? `${Math.round(b.winRate * 100)}%` : "—"}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
                <p className="stats-muted">
                  Win rates are honest, not claimed — every outcome is recorded on-chain by the
                  Reporter wallet.
                </p>
              </>
            )}
          </>
        )}
      </section>
        </>
      )}

      <footer className="footer">
        Built on Arc Testnet
      </footer>
    </div>
  );
}
