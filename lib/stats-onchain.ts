import { createPublicClient, http } from "viem";
import { arcChain } from "./arc.js";

// ReputationRegistry (прокси) — ERC-8004. Репутацию агента читаем через
// view-функции (eth_call), не через getLogs: getLogs на Arc-тестнете
// воспроизводимо расходится, eth_call стабилен.
const REPUTATION_REGISTRY = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const AGENT_ID = 851687n;

const abi = [
  { type: "function", name: "getClients", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address[]" }] },
  { type: "function", name: "getSummary", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address[]" }, { type: "string" }, { type: "string" }], outputs: [{ type: "uint64" }, { type: "int128" }, { type: "uint8" }] },
] as const;

export interface OnchainTrackRecord {
  total: number;    // валидированных предсказаний (фидбеков)
  resolved: number; // = total: фидбек пишется только после резолва
  correct: number;
  accuracy: number | null; // 0..1
}

// getSummary(agentId, clients, tag, "") -> (count, avgValue, decimals).
// tag "" = все фидбеки; tag "prediction_correct" = только верные
// (проверено на тестнете: (10,68,0) и (6,100,0); 68 = среднее: 6×100+4×20=680/10).

// Кэш переживает ошибки: при сбое отдаём последний успешный результат,
// даже просроченный (цифры меняются раз в дни). Прочерк — только если
// успеха не было ни разу (тогда /stats отвечает 500, фронт показывает «—»).
let lastSuccess: { at: number; data: OnchainTrackRecord } | null = null;
const TTL_MS = 60_000;

// Перебор всех RPC из arc.ts (arc.io → arc.network → blockdaemon → drpc):
// /stats не должен падать в 500 из-за одной ноды.
async function withRpcFallback<T>(fn: (rpcUrl: string) => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (const rpcUrl of arcChain.rpcUrls.default.http) {
    try {
      return await fn(rpcUrl);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function fetchFresh(): Promise<OnchainTrackRecord> {
  return withRpcFallback(async (rpcUrl) => {
    const publicClient = createPublicClient({ chain: arcChain, transport: http(rpcUrl) });
    const clients = (await publicClient.readContract({
      address: REPUTATION_REGISTRY,
      abi,
      functionName: "getClients",
      args: [AGENT_ID],
    })) as `0x${string}`[];
    if (clients.length === 0) {
      return { total: 0, resolved: 0, correct: 0, accuracy: null };
    }
    const [total] = await publicClient.readContract({
      address: REPUTATION_REGISTRY,
      abi,
      functionName: "getSummary",
      args: [AGENT_ID, clients, "", ""],
    });
    const [correct] = await publicClient.readContract({
      address: REPUTATION_REGISTRY,
      abi,
      functionName: "getSummary",
      args: [AGENT_ID, clients, "prediction_correct", ""],
    });
    const t = Number(total);
    const c = Number(correct);
    return { total: t, resolved: t, correct: c, accuracy: t > 0 ? c / t : null };
  });
}

export async function getOnchainTrackRecord(): Promise<OnchainTrackRecord> {
  const now = Date.now();
  if (lastSuccess && now - lastSuccess.at < TTL_MS) return lastSuccess.data;
  try {
    const data = await fetchFresh();
    lastSuccess = { at: now, data };
    return data;
  } catch (err) {
    if (lastSuccess) return lastSuccess.data; // устаревшее лучше прочерка
    throw err;
  }
}
