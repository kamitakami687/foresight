# Foresight

![Foresight logo](logo.jpg)

# Website: https://foresight-predict.vercel.app/

Foresight is a prediction app built on Arc Testnet, using USDC for gas payments. Powered by an autonomous AI agent that makes 5 min, 15 min, 1 hour, and 4 hour BTC and ETH predictions, gets paid, and refunds the user 90% when wrong.

Foresight is an autonomous prediction agent built on Arc that brings AI-powered forecasts to Polymarket's short-term Bitcoin and Ethereum markets, 5 minutes, 15 minutes, 1 hour, or 4 hours out. Every prediction is requested and paid for through Circle's x402 Nanopayments, a gasless, signed agentic payment protocol, and the agent itself holds a verifiable onchain identity and reputation record under the ERC-8004 standard, so its real accuracy can be checked independently, not just claimed.

Built on Arc, where USDC is the native gas token, so there's nothing extra to hold just to pay network fees. A live example of the agentic economy in action.

Foresight uses Binance klines as the primary price source, since it updates every minute with no API key needed, and Polymarket's own CLOB midpoint as a comparison signal, since it shows what the market itself is pricing the outcome at right now — letting the app show when its own prediction agrees or disagrees with the crowd.

A live timer shows how much time remains until the prediction resolves; once it hits zero, a Check Outcome button appears.

---

## How the wallets work

Foresight has four wallets, each with one clear job.

- **Seller** is where the $0.01 payment first lands when someone pays for a prediction.
- **Escrow** is where that money actually ends up living, it either keeps the $0.01 if the prediction was right, or sends 90% of it back if the prediction was wrong.
- **Validator** is the AI agent's onchain identity, like a name tag proving the agent is a real, trackable thing, not invisible code.
- **Reporter** is a separate wallet that writes down, permanently, whether each prediction the Validator checked was correct or wrong, so anyone can look up its real track record.

### Technical breakdown

| Wallet | Env variable | Type | What it does |
|---|---|---|---|
| Seller | X402_SELLER_ADDRESS, X402_SELLER_PRIVATE_KEY | Self-custodied | Receives each $0.01 payment |
| Escrow | ESCROW_WALLET_ADDRESS | Circle-managed | Holds the funds and sends refunds when a prediction is wrong |
| Validator | VALIDATOR_WALLET_ADDRESS, VALIDATOR_WALLET_ID, VALIDATOR_AGENT_ID | Circle-managed | Holds the AI agent's onchain identity |
| Reporter | REPORTER_WALLET_ADDRESS, REPORTER_WALLET_ID | Circle-managed | Independently records whether each prediction was right or wrong |

### The money flow, start to finish

```
Visitor's own wallet
  -> deposits USDC into their own Gateway balance
  -> pays $0.01 (signed, gasless) -> lands in Seller's Gateway balance
  -> sweep fires automatically -> burns from Seller's Gateway balance
                               -> mints real onchain USDC into Escrow
  -> market resolves:
     correct prediction -> Escrow keeps the $0.01
     wrong prediction   -> Escrow sends 0.009 USDC back to the visitor
```

### The reputation flow, running alongside it

```
Validator (has an onchain identity, ERC-8004 agent ID 851687)
  -> identity registered via IdentityRegistry.register()

Reporter (independent observer, never the Validator itself,
required by ERC-8004's anti-self-dealing rule)
  -> once a prediction's market has resolved, submits a real feedback
     transaction to ReputationRegistry.giveFeedback():
        correct prediction -> score 100, tag "prediction_correct"
        wrong prediction   -> score 20,  tag "prediction_incorrect"
  -> each one is a real, independently verifiable onchain event
```

Once the market closes, a Check Outcome button appears in the app so you can verify the result yourself. If the prediction was wrong, the Escrow wallet automatically refunds you 90% of the fee, and the result then stays fixed in place, so the same prediction is never checked or refunded twice.

**Note on the name:** the project was originally called PolyPredict, but the name was already in use by another product, so it was changed to Foresight. The only place "PolyPredict" still appears is the Validator agent's onchain ERC-8004 identity, registered before the rename. Since that registration is permanent, it keeps the original name even though the project itself is now Foresight.

---

## Architecture

```
foresight/
├── lib/
│   ├── analyst-agent.ts       # Combines Binance price signals + CLOB odds into a prediction
│   ├── arc.ts                 # Arc network config: chain ID, RPC, USDC address
│   ├── gateway-deposit.ts     # Gateway balance deposit helpers (frontend-facing)
│   ├── gateway-signer.ts      # EIP-712 signing for gasless x402 payments
│   ├── history.ts             # Calibration history store + win-rate stats (/stats)
│   ├── polymarket.ts          # Fetches market data from Polymarket's Gamma API + CLOB
│   └── validator-agent.ts     # Checks a resolved market's outcome, decides match/refund
├── server/
│   ├── index.ts               # Express app entry point, mounts all routes
│   ├── predict.ts             # POST /predict, x402-gated, returns a prediction
│   └── validate.ts            # POST /validate (checks outcome, refund + feedback), GET /stats
├── scripts/
│   ├── create-validator-identity.ts  # Registers the Validator's ERC-8004 identity
│   ├── generate-seller-wallet.ts     # Creates the Seller wallet (viem keypair)
│   ├── get-validator-reputation.ts   # Reads back the Validator's onchain track record
│   ├── refund-user.ts                # Sends the 90% refund from Escrow
│   └── sweep-to-escrow.ts            # Sweeps Seller's Gateway balance into real onchain Escrow USDC
├── frontend/
│   ├── App.tsx                # Main UI: wallet connect, Gateway deposit, predictions, Check Outcome
│   ├── main.tsx                # React entry point
│   └── styles.css              # Design system + component styles
├── tests/
│   └── run.ts                 # Deterministic unit tests (npm test)
├── .env.example
└── README.md
```

### Data flow

```
Visitor's wallet (MetaMask)
    |
    v
EIP-6963 wallet discovery + viem (wallet connect, chain check, EIP-712 signing)
    |
    v
frontend/App.tsx
    |
    +-- reads market data via:  lib/polymarket.ts   -> Polymarket Gamma API + CLOB
    +-- reads price signals via: lib/analyst-agent.ts -> Binance klines
    +-- pays via:                x402 Nanopayments    -> server/predict.ts
    +-- checks outcome via:      POST /validate        -> server/validate.ts
    |
    v
server/validate.ts
    |
    +-- resolves market:   lib/validator-agent.ts
    +-- refunds if wrong:  scripts/refund-user.ts        -> Escrow wallet
    +-- logs reputation:   ReputationRegistry.giveFeedback() -> Reporter wallet
```

---

## Deployment & Architecture

Foresight deploys as two separate Vercel projects from one repository: the frontend (`foresight-predict.vercel.app`, Vite preset) and the backend (`foresight-api.vercel.app`, Express preset). The frontend's `vercel.json` rewrites every `/api/*` request to the backend project.

**Why not one Express + Vite project?** Vercel snapshots `public/**` for its static builder *before* the build command runs. On a clean deploy the freshly-built frontend doesn't exist yet, so the static output is always empty and every request falls through to Express — the classic `Cannot GET /`. Splitting the projects lets each one use the builder it was made for.

- `vite.config.ts` builds into `dist/` (Vite's default). The earlier setup pointed `build.outDir` at `public/`, which made Vercel's static collection non-deterministic — empty builds on some deploys, a race between Vite's output and the static builder on others. `dist/` keeps the two apart.
- `typescript` is pinned to `6.0.3`. TypeScript 7's native compiler doesn't expose `ts.sys` the way `@vercel/node`'s tooling expects, so the backend build breaks on TS7.
- The Circle SDK (`@circle-fin/developer-controlled-wallets`) is imported dynamically (`await import(...)` inside the functions that need it). A top-level static named import crashes module load under Vercel's native ESM loader — the CJS interop layer can't synthesize named exports for this package.
- `package.json` overrides `uuid` to `^11.1.1`. `@circle-fin/app-kit` unconditionally requires `@solana/web3.js`, which pulls in `rpc-websockets`, which `require()`s `uuid` — and uuid 14 dropped CommonJS entirely.
- The wallet layer doesn't use wagmi. Wallets are discovered through raw EIP-6963 `announceProvider` events, connected with a direct `eth_requestAccounts`, and switched to Arc with `wallet_switchEthereumChain` (falling back to `wallet_addEthereumChain` on 4902) — all on the chosen wallet's own provider object, with viem clients created directly. wagmi's connector/client wrappers silently blocked the network switch in real wallets; the raw-provider path is how working Arc dApps (AnchorPay, ArcShift) do it.
- Arc Testnet parameters: chain ID 5042002, RPC `https://rpc.testnet.arc.io` (fallback `https://rpc.testnet.arc.network`), USDC as the native gas token with 18 decimals, explorer `testnet.arcscan.app`.

**Testing the wallet layer:** test locally with `npm run dev` and a real wallet (MetaMask or Rabby) — not by deploying. Local dev runs on `tsx`, which is more permissive about ESM/CJS interop than Vercel's runtime, so a bug that only appears after deploy is the expensive way to find it.

---

## Deployed contracts (Arc Testnet)

| Contract | Address | Purpose |
|---|---|---|
| IdentityRegistry (ERC-8004) | 0x8004A818BFB912233c491871b3d84c89A494BD9e | Holds the Validator's onchain identity, agent ID 851687 |
| ReputationRegistry (ERC-8004) | 0x8004B663056A597Dffe9eCcC1965A193B7388713 | Stores every giveFeedback() outcome the Reporter submits |
| USDC (ERC-20 interface) | 0x3600000000000000000000000000000000000000 | Used for all deposits, payments, and refunds |

View the Validator's identity onchain:
https://testnet.arcscan.app/token/0x8004A818BFB912233c491871b3d84c89A494BD9e/instance/851687

View the Reporter's transaction history:
https://testnet.arcscan.app/address/0xa75dbd9e467edd520381b8eecb75ef78f0c1f0ea

---

## Arc Testnet specifics

- Chain ID: 5042002
- Native gas token: USDC, two interfaces on one token: native gas balance uses 18 decimals, the ERC-20 interface (0x3600...) uses 6 decimals. All app-level transfers use the 6-decimal ERC-20 interface.
- Explorer: testnet.arcscan.app
- RPC: primary https://rpc.testnet.arc.io, fallback https://rpc.testnet.arc.network, configured in lib/arc.ts (single source of truth for the chain everywhere).
- Nanopayments: built on @circle-fin/x402-batching, not the generic x402-foundation packages, since Arc support is specific to Circle's own Gateway-based implementation.

---

## Tech stack

Node.js and React, Circle's Nanopayments and wallet tools for instant USDC payments, live Binance and Polymarket data for price signals, OpenAI for reasoning, and the ERC-8004 standard on Arc Testnet for the agent's onchain identity and track record.

| Layer | Technology |
|---|---|
| Backend | Node.js / TypeScript, Express |
| Frontend | React, Vite, viem (EIP-6963 wallet discovery) |
| Payments | @circle-fin/x402-batching (gasless Nanopayments) |
| Wallets | @circle-fin/developer-controlled-wallets |
| Price signals | Binance public klines API |
| Market signal | Polymarket Gamma API + CLOB midpoint |
| Reasoning | OpenAI |
| Identity & reputation | ERC-8004 (IdentityRegistry, ReputationRegistry) on Arc Testnet |

---

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with:
- A Circle API key and registered Entity Secret (from console.circle.com)
- Fresh Seller, Validator, and Reporter wallet credentials (see `scripts/`)
- An OpenAI API key

Fund your wallet with testnet USDC at faucet.circle.com, then deposit into your Gateway balance from the app's onboarding flow before making a prediction.

Run the backend and frontend:

```bash
npm run server   # starts the Express API on :3001
npm run dev      # starts the Vite frontend on :5173
```

---

## Manual testing

## *The online version is in progress

A judge or reviewer can verify the whole flow themselves, end to end:

1. Open the app and click Connect Wallet. Confirm you're prompted to switch to Arc Testnet if you're not already on it.
2. Enter an amount in AMOUNT and click Deposit. Confirm GATEWAY BALANCE updates after the transaction settles.
3. Type a question like "Bitcoin up or down?", or paste a Polymarket market link.
4. Click Predict on the 5 Min column. Approve the signature prompt in your wallet, this is gasless, not a transaction.
5. Confirm a prediction renders: outcome (UP/DOWN), a confidence score, and a plain-language explanation referencing real price data.
6. Watch the countdown tick down live. Once it reaches zero, confirm a Check Outcome button appears.
7. Click it. Confirm the result renders: either a green "correct, fee kept" message, or a red "wrong, refunded" message with a transaction hash linking to Arcscan.
8. Click the transaction link and confirm it resolves to a real, confirmed transaction on Arc Testnet's explorer.

---

## Security note

`.env` is never committed. Every credential (API key, entity secret, private keys) must be generated fresh by anyone cloning this repo, see `.env.example` for the required variable names.

This is a testnet project built for the Arc Agentic Economy Hackathon and is not intended for production use without further security review.
