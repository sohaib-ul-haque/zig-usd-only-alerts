import { config } from "./config";

const cache = new Map<string, { price: number; at: number }>();

/**
 * Returns the current USD price for a CoinGecko coin id, using a short-lived
 * in-memory cache per id so we don't hammer CoinGecko on every alert.
 * Returns null if the price can't be fetched (alert will still go out,
 * just without the USD line).
 */
export async function getUsdPrice(coingeckoId: string): Promise<number | null> {
  const now = Date.now();
  const cached = cache.get(coingeckoId);
  if (cached && now - cached.at < config.price.cacheMs) {
    return cached.price;
  }

  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) {
      console.error(`[PRICE] CoinGecko error: ${res.status}`);
      return cached?.price ?? null; // fall back to whatever we last had, if anything
    }

    const data = (await res.json()) as Record<string, { usd?: number }>;
    const usd = data?.[coingeckoId]?.usd;

    if (typeof usd !== "number") {
      console.error("[PRICE] Unexpected CoinGecko response shape:", data);
      return cached?.price ?? null;
    }

    cache.set(coingeckoId, { price: usd, at: now });
    return usd;
  } catch (err) {
    console.error("[PRICE] Fetch failed:", (err as Error).message);
    return cached?.price ?? null;
  }
}
