import "dotenv/config";
import { randomUUID } from "node:crypto";
import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http, parseAbiItem, decodeEventLog } from "viem";
import { arcTestnet } from "viem/chains";
import { ARC_CONFIG } from "../lib/arc.js";

const IDENTITY_REGISTRY_ADDRESS = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const BLOCKCHAIN = "ARC-TESTNET";
const FUNDING_AMOUNT_USDC = "0.1"; // light — just enough gas for a handful of ops
const FUNDING_SOURCE_ADDRESS = process.env.ESCROW_WALLET_ADDRESS!;

const VALIDATOR_METADATA = {
  name: "PolyPredict Validator",
  description:
    "Checks Bitcoin and Ethereum prediction outcomes, triggers refunds for incorrect predictions",
  agent_type: "validator",
  capabilities: ["outcome_verification", "refund_triggering"],
  version: "1.0.0",
};

// No metadata-hosting infrastructure exists in this project (no IPFS, no
// public URL) — a data: URI embeds the JSON directly on-chain, so
// register() doesn't depend on anything external.
function toDataUri(metadata: object): string {
  const json = JSON.stringify(metadata);
  return `data:application/json;base64,${Buffer.from(json).toString("base64")}`;
}

const client = initiateDeveloperControlledWalletsClient({
  apiKey: process.env.CIRCLE_API_KEY!,
  entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
});
const publicClient = createPublicClient({
  chain: arcTestnet,
  transport: http("https://arc-testnet.drpc.org"),
});

async function waitForTx(id: string) {
  const res = await client.getTransaction({ id, waitForState: "COMPLETE" });
  return res.data!.transaction!;
}

console.log("=== 1. Creating wallet set 'PolyPredict Validator' ===");
const walletSetRes = await client.createWalletSet({ name: "PolyPredict Validator" });
const walletSetId = walletSetRes.data!.walletSet.id;
console.log(`walletSetId: ${walletSetId}`);

console.log("\n=== 2. Creating 2 SCA wallets on ARC-TESTNET ===");
const walletsRes = await client.createWallets({
  blockchains: [BLOCKCHAIN],
  count: 2,
  accountType: "SCA",
  walletSetId,
  metadata: [{ name: "PolyPredict Validator" }, { name: "PolyPredict Reporter" }],
});
const wallets = walletsRes.data!.wallets;
const validatorWallet = wallets.find((w) => w.name === "PolyPredict Validator")!;
const reporterWallet = wallets.find((w) => w.name === "PolyPredict Reporter")!;
console.log(`VALIDATOR wallet: id=${validatorWallet.id} address=${validatorWallet.address}`);
console.log(`REPORTER wallet:  id=${reporterWallet.id} address=${reporterWallet.address}`);

// Funding has to happen BEFORE registration, not after (as originally
// ordered in the task) — the VALIDATOR wallet needs USDC-as-gas on Arc to
// submit the register() transaction at all. Funding both here.
console.log("\n=== 3. Funding both wallets lightly (moved before registration — see note above) ===");
for (const [label, wallet] of [
  ["VALIDATOR", validatorWallet],
  ["REPORTER", reporterWallet],
] as const) {
  const fundTxRes = await client.createTransaction({
    walletAddress: FUNDING_SOURCE_ADDRESS,
    blockchain: BLOCKCHAIN,
    tokenAddress: ARC_CONFIG.usdcErc20Address,
    destinationAddress: wallet.address,
    amount: [FUNDING_AMOUNT_USDC],
    fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    idempotencyKey: randomUUID(),
  });
  const fundTx = await waitForTx(fundTxRes.data!.id);
  console.log(`  funded ${label} (${wallet.address}) with ${FUNDING_AMOUNT_USDC} USDC: txHash=${fundTx.txHash}`);
}

console.log("\n=== 4. Registering VALIDATOR identity on IdentityRegistry ===");
const agentURI = toDataUri(VALIDATOR_METADATA);
const registerTxRes = await client.createContractExecutionTransaction({
  walletAddress: validatorWallet.address,
  blockchain: BLOCKCHAIN,
  contractAddress: IDENTITY_REGISTRY_ADDRESS,
  abiFunctionSignature: "register(string)",
  abiParameters: [agentURI],
  fee: { type: "level", config: { feeLevel: "MEDIUM" } },
  idempotencyKey: randomUUID(),
});
console.log(`register() tx submitted: ${registerTxRes.data!.id}`);
const registerTx = await waitForTx(registerTxRes.data!.id);
console.log(`register() tx state: ${registerTx.state}, txHash: ${registerTx.txHash}`);

console.log("\n=== 5. Parsing Transfer event for agentId ===");
const receipt = await publicClient.getTransactionReceipt({
  hash: registerTx.txHash as `0x${string}`,
});
const transferEvent = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);
let agentId: bigint | undefined;
for (const log of receipt.logs) {
  if (log.address.toLowerCase() !== IDENTITY_REGISTRY_ADDRESS.toLowerCase()) continue;
  try {
    const decoded = decodeEventLog({ abi: [transferEvent], data: log.data, topics: log.topics });
    if (
      decoded.eventName === "Transfer" &&
      decoded.args.from === "0x0000000000000000000000000000000000000000"
    ) {
      agentId = decoded.args.tokenId;
      break;
    }
  } catch {
    // not this log's event shape — skip
  }
}
if (agentId === undefined) {
  throw new Error(
    `Could not find a mint Transfer event (from=0x0) in tx ${registerTx.txHash} on ${IDENTITY_REGISTRY_ADDRESS}`
  );
}
console.log(`agentId: ${agentId}`);

console.log("\n=== Summary — append these to .env ===");
console.log(`VALIDATOR_WALLET_ID=${validatorWallet.id}`);
console.log(`VALIDATOR_WALLET_ADDRESS=${validatorWallet.address}`);
console.log(`VALIDATOR_AGENT_ID=${agentId}`);
console.log(`REPORTER_WALLET_ID=${reporterWallet.id}`);
console.log(`REPORTER_WALLET_ADDRESS=${reporterWallet.address}`);
