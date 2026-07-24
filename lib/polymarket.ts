const GAMMA_API_BASE = "https://gamma-api.polymarket.com";

export const ASSETS = {
  bitcoin: { tagId: "235", coingeckoId: "bitcoin" },
  ethereum: { tagId: "39", coingeckoId: "ethereum" },
} as const;

export const DURATIONS = {
  "5m": { tagId: "102892", minMinutes: 3, maxMinutes: 7 },
  "15m": { tagId: "102467", minMinutes: 10, maxMinutes: 20 },
  "1h": { tagId: "102175", minMinutes: 45, maxMinutes: 75 },
  "4h": { tagId: "102531", minMinutes: 180, maxMinutes: 300 },
} as const;

export const UP_OR_DOWN_TAG_ID = "102127";

export type AssetKey = keyof typeof ASSETS;

// Real Polymarket slugs use tickers ("btc-updown-5m-..."), not full names,
// so asset detection has to match either.
export const ASSET_ALIASES: Record<AssetKey, string[]> = {
  bitcoin: ["bitcoin", "btc"],
  ethereum: ["ethereum", "eth"],
};

export type DurationKey = keyof typeof DURATIONS;

interface GammaTag {
  id: string;
  slug: string;
  label: string;
}

// outcomes/clobTokenIds/outcomePrices come back from the Gamma API as
// JSON-encoded strings (e.g. '["Up","Down"]'), not real arrays — callers
// must JSON.parse them. clobTokenIds and outcomePrices are both ordered
// positionally to match outcomes.
export interface GammaMarket {
  outcomes: string;
  clobTokenIds: string;
  outcomePrices: string;
  [key: string]: unknown;
}

export interface GammaEvent {
  slug: string;
  title: string;
  active: boolean;
  closed: boolean;
  endDate: string;
  tags: GammaTag[];
  markets: GammaMarket[];
  [key: string]: unknown;
}

// The Gamma API's /events endpoint does not support combining multiple
// tag_id filters: duplicate tag_id params are silently ignored (only the
// first is honored), and the comma-separated form (tag_id=a,b) returns
// HTTP 422. So we fetch by the asset tag and filter client-side for the
// duration tag's presence in each event's own tags array.
//
// Sorting: recurring markets (e.g. a new 5-minute BTC window every 5
// minutes) stay listed ~24h before their actual resolution window, so
// order=startDate&ascending=false (most recently created first) surfaces
// the *furthest-future* instance, not the soonest to close. We sort by
// endDate ascending instead so the first duration-tagged match is always
// the next one to actually resolve. That alone isn't safe, though: without
// an end_date_min filter the API still returns long-expired events despite
// closed=false&active=true (same kind of param-ignoring quirk as the
// tag_id limitation above) — end_date_min excludes those.
export async function listActiveMarkets(
  assetKey: AssetKey,
  durationKey: DurationKey
): Promise<GammaEvent[]> {
  const asset = ASSETS[assetKey];
  const duration = DURATIONS[durationKey];

  const url = new URL(`${GAMMA_API_BASE}/events`);
  url.searchParams.set("tag_id", asset.tagId);
  url.searchParams.set("closed", "false");
  url.searchParams.set("active", "true");
  url.searchParams.set("limit", "100");
  url.searchParams.set("order", "endDate");
  url.searchParams.set("ascending", "true");
  url.searchParams.set("end_date_min", new Date().toISOString());

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Gamma API request failed: ${res.status} ${res.statusText}`);
  }

  const events = (await res.json()) as GammaEvent[];
  return events.filter((event) =>
    event.tags?.some((tag) => tag.id === duration.tagId)
  );
}

// Looks up a single event by its exact slug (e.g. from a market URL the
// user pasted, or a slug already known from a prior listActiveMarkets
// call) — used by the validator to re-check a specific market later,
// regardless of whether it's still active.
export async function getMarketBySlug(slug: string): Promise<GammaEvent | null> {
  const url = new URL(`${GAMMA_API_BASE}/events`);
  url.searchParams.set("slug", slug);

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`Gamma API request failed: ${res.status} ${res.statusText}`);
  }

  const events = (await res.json()) as GammaEvent[];
  return events[0] ?? null;
}
