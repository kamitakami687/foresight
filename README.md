# Foresight

![Foresight logo](logo.jpg)

Foresight is a live Polymarket prediction app that currently supports 5 minute, 15 minute, 1 hour, and 4 hour predictions for BTC and ETH.

To get a prediction, you first deposit USDC to your Gateway balance. Then you just paste a Polymarket link, choose a timeframe, or type in a question like *"Bitcoin/Ethereum be up or down?"* You pay $0.01, and an AI agent looks at real market data to give you a live prediction with its reasoning.

Once the market resolves, the Validator checks if the prediction was right. Wrong predictions get 90% refunded automatically. Every result is logged permanently on-chain by the Reporter wallet — the track record is public, not just claimed.

Foresight uses Binance klines as the primary price source, since it updates every minute with no API key needed. Polymarket's own CLOB midpoint as a new signal, since it shows what the market itself is pricing the outcome at right now, which lets the app show when its own prediction agrees or disagrees with the crowd.

Foresight runs on Arc using USDC, with instant, gas-free payments through Circle's Nanopayments. Foresight combines two live signals: Binance's minute-by-minute price data for real market momentum, and Polymarket's own CLOB midpoint for what the crowd is actually pricing. That pairing lets the app show, transparently, when its own call agrees with the market and when it's taking a different view.

The agent pulls live price data from Binance candlestick lines and Polymarket's own order book for real-time price and sentiment analysis. 

More supported assets are planned.

The Validator's onchain identity and every feedback event it has received are independently verifiable on [Arc Testnet's explorer](https://testnet.arcscan.app) so this isn't something you have to take Foresight's word for.

---

## How the wallets work

Foresight has five wallets, each with one clear job.

- **Client** is a browser wallet (Metamask, Rabby) for a regular visitor, used for testing.
- **Seller** is where the $0.01 payment first lands when someone pays for a prediction.
- **Escrow** is where that money actually ends up living — it either keeps the $0.01 if the prediction was right, or sends 90% of it back if the prediction was wrong.
- **Validator** is the AI agent's on-chain identity, a name tag proving the agent is a real, trackable thing, not invisible code.
- **Reporter** is a separate wallet that writes down, permanently, whether each prediction the Validator checked was correct or wrong, so anyone can look up its real track record.
  
### Technical breakdown

| Wallet | Env variable | Type | What it does |
|---|---|---|---|
| Client | CLIENT_WALLET_ADDRESS | Any visitor's wallet | Represents whoever is testing the app |
| Seller | X402_SELLER_ADDRESS, X402_SELLER_PRIVATE_KEY | Self-custodied | Receives each $0.01 payment |
| Escrow | ESCROW_WALLET_ADDRESS | Circle-managed | Holds the funds and sends refunds when a prediction is wrong |
| Validator | VALIDATOR_WALLET_ADDRESS, VALIDATOR_WALLET_ID, VALIDATOR_AGENT_ID | Circle-managed | Holds the AI agent's on-chain identity |
| Reporter | REPORTER_WALLET_ADDRESS, REPORTER_WALLET_ID | Circle-managed | Independently records whether each prediction was right or wrong |`ReputationRegistry` about the Validator's agent ID after every resolved prediction |

### The money flow, start to finish

```
Visitor's own wallet
  → deposits USDC into their own Gateway balance
  → pays $0.01 (signed, gasless) → lands in Seller's Gateway balance
  → sweep fires automatically → burns from Seller's Gateway balance
                               → mints real on-chain USDC into Escrow
  → market resolves:
     correct prediction → Escrow keeps the $0.01
     wrong prediction   → Escrow sends 0.009 USDC back to the visitor
```

### The reputation flow, running alongside it

```
Validator (has an on-chain identity, ERC-8004 agent ID 851687)
  → identity registered via IdentityRegistry.register()

Reporter (independent observer, never the Validator itself —
required by ERC-8004's anti-self-dealing rule)
  → after every /validate call, submits a real feedback transaction
    to ReputationRegistry.giveFeedback():
       correct prediction → score 100, tag "prediction_correct"
       wrong prediction   → score 20,  tag "prediction_incorrect"
  → each one is a real, independently verifiable onchain event —
    anyone can query the Validator's full accuracy history directly
    from the contract, not from anything Foresight itself claims
```

> **A note on the name:** the on-chain Validator agent's identity
metadata still reads "PolyPredict Validator" — that's the project's
original name at the time of ERC-8004 registration. Since that
registration is permanent and re-registering would mean losing the
agent's existing on-chain reputation history, the on-chain record
keeps the old name even though the project itself is now called
Foresight.

### SCA vs. EOA — the two wallet types, compared simply

**SCA** stands for Smart Contract Account — a type of wallet that's actually a small smart contract on the blockchain, rather than a traditional wallet controlled directly by a single private key.

- **EOA (Externally Owned Account)** — the traditional kind. One private key, that key signs everything directly. This is what most of the other wallets in this project are (Client, Escrow) — simpler, works everywhere.
- **SCA (Smart Contract Account)** — the wallet itself is a program running on the blockchain. It can have more sophisticated rules baked in: multiple ways to authorize an action, spending limits, recovery options if a key is lost, and, in some setups, sponsored gas.

Validator and Reporter are created as SCA wallets, matching Circle's own ERC-8004 quickstart pattern for these roles. This project funds them manually with a small amount of testnet USDC to cover gas for registration and feedback transactions, rather than using Circle's Gas Station sponsorship feature.

**Simple analogy:** an EOA is like a regular bank account where only you can sign a check. An SCA is more like a company account with built-in rules — maybe recovery options if someone loses access — because the account itself is smart, not just a static key.

---

## Tech stack

- Node.js / TypeScript, Express (backend)
- React + Vite, Wagmi + viem (frontend, wallet connection)
- @circle-fin/x402-batching, Circle's Nanopayments (gasless x402 payments on Arc)
- @circle-fin/developer-controlled-wallets — Escrow, Validator, and Reporter wallets
- Binance public klines API for real-time price momentum and volatility signals
- Polymarket Gamma API + CLOB — market data and crowd-priced odds 
- OpenAI — generates the plain-language rationale behind each prediction
- ERC-8004 on Arc Testnet - the Validator's onchain identity and track record

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with:
- A Circle API key and registered Entity Secret (from [console.circle.com](https://console.circle.com))
- Fresh Seller, Validator, and Reporter wallet credentials (see `scripts/`)
- An OpenAI API key

Fund your wallets with testnet USDC at [faucet.circle.com](https://faucet.circle.com), then deposit into your Gateway balance from the app's onboarding flow before making a prediction.

Run the backend and frontend:

```bash
npm run server
npm run dev
```

## Security note

`.env` is never committed. Every credential (API key, entity secret, private keys) must be generated fresh by anyone cloning this repo — see `.env.example` for the required variable names.

This is a testnet project built for the Arc Agentic Economy Hackathon and is not intended for production use without further security review.
