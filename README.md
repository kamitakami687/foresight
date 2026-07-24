# PolyPredict

PolyPredict is a live Polymarket prediction app supporting 5-minute, 15-minute, 1-hour, and 4-hour predictions for BTC and ETH.

To get a prediction, you first deposit USDC to your Gateway balance. Then paste a Polymarket link, choose a timeframe, or ask a question like "will Bitcoin be up or down in the next hour?" You pay $0.01, and an AI agent looks at real market data to give you a prediction along with its reasoning.

Once the market resolves, if the prediction was wrong, you automatically get 90% of your money back (0.009 USDC). PolyPredict runs on Arc using USDC, with gas-free payments via Circle's Nanopayments (x402).

## The five wallets

| Wallet | Job |
|---|---|
| **Client** | Stand-in for a test visitor / payer |
| **Seller** | Receives the $0.01 payment when someone pays for a prediction |
| **Escrow** | Holds the funds — keeps the $0.01 on a correct prediction, pays out the 0.009 USDC refund on a wrong one |
| **Validator** | The AI agent's on-chain identity — an ERC-8004 agent ID (851687) registered on Arc Testnet's IdentityRegistry |
| **Reporter** | A separate wallet that logs whether each prediction the Validator checked was correct or wrong, via `ReputationRegistry.giveFeedback()` — score 100 for a correct call, 20 for an incorrect one, each a real, independently verifiable on-chain transaction on [Arc Testnet's explorer](https://testnet.arcscan.app) |

Validator and Reporter are SCA (Smart Contract Account) wallets, funded manually with a small amount of testnet USDC to cover gas for identity registration and feedback transactions. This project does not use Circle's Gas Station gas-sponsorship feature.

## Tech stack

- Node.js / TypeScript, Express (backend)
- React + Vite, wagmi + viem (frontend, wallet connection)
- `@circle-fin/x402-batching` — Circle's Nanopayments (gasless x402 payments on Arc)
- `@circle-fin/developer-controlled-wallets` — Escrow, Validator, and Reporter wallets
- Binance public klines API — real-time price momentum and volatility signals
- Polymarket Gamma API + CLOB — market data and crowd-priced odds
- OpenAI — generates the plain-language rationale behind each prediction
- ERC-8004 (IdentityRegistry, ReputationRegistry) on Arc Testnet — the Validator's on-chain identity and track record

## Setup

```
npm install
cp .env.example .env
```

Fill in `.env` with:
- A Circle API key and registered Entity Secret (from console.circle.com)
- Seller, Validator, and Reporter wallet credentials (see `scripts/`)
- An OpenAI API key

Fund your wallets with testnet USDC at [faucet.circle.com](https://faucet.circle.com), then deposit into your Gateway balance before making a prediction.

Run the backend and frontend:

```
npm run server
npm run dev
```

## Security note

`.env` is never committed. Every credential (API key, entity secret, private keys) must be generated fresh by anyone cloning this repo — see `.env.example` for the required variable names.

This is a testnet project built for the Arc Agentic Economy Hackathon and is not intended for production use without further security review.
