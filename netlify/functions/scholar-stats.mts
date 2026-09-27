import { getStore } from "@netlify/blobs";
import type { Config } from "@netlify/functions";

const SCHOLAR_AUTHOR_ID = "F8AtOioAAAAJ";
const CACHE_KEY = "stats";
const MAX_AGE_MS = 20 * 60 * 60 * 1000; // 20 hours — refresh at most a few times a day
const FETCH_TIMEOUT_MS = 12000;

// Baked-in fallback, matching the numbers on the CV as of Sept 2026.
// Only ever used if there is no cached value AND a live fetch fails.
const FALLBACK = {
  citations: 511,
  citationsSince: 482,
  sinceYear: 2021,
  hIndex: 11,
  i10Index: 12,
  updatedAt: null as string | null,
  source: "fallback" as const,
};

type ScholarStats = typeof FALLBACK;

async function fetchFromSerpApi(): Promise<ScholarStats> {
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error("SERPAPI_KEY is not configured");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const url = `https://serpapi.com/search.json?engine=google_scholar_author&author_id=${SCHOLAR_AUTHOR_ID}&api_key=${apiKey}`;
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`SerpApi responded with HTTP ${res.status}`);
    }

    const data = await res.json();

    if (data.error) {
      throw new Error(`SerpApi error: ${data.error}`);
    }

    const table: Array<Record<string, { all?: number; since_2021?: number } & Record<string, number>>> =
      data?.cited_by?.table ?? [];

    const findRow = (key: string) => table.find((row) => key in row)?.[key];

    const citationsRow = findRow("citations");
    const hIndexRow = findRow("h_index");
    const i10IndexRow = findRow("i10_index");

    if (!citationsRow || typeof citationsRow.all !== "number") {
      throw new Error("Unexpected SerpApi response shape: no citations table found");
    }

    // The "since" column key changes each year (e.g. since_2021, since_2022...);
    // pull whichever since_XXXX key is present rather than hardcoding the year.
    const sinceKey = Object.keys(citationsRow).find((k) => k.startsWith("since_"));
    const sinceYear = sinceKey ? Number(sinceKey.replace("since_", "")) : FALLBACK.sinceYear;
    const citationsSince = sinceKey ? citationsRow[sinceKey] : FALLBACK.citationsSince;

    return {
      citations: citationsRow.all,
      citationsSince: citationsSince ?? FALLBACK.citationsSince,
      sinceYear,
      hIndex: hIndexRow?.all ?? FALLBACK.hIndex,
      i10Index: i10IndexRow?.all ?? FALLBACK.i10Index,
      updatedAt: new Date().toISOString(),
      source: "scholar",
    };
  } finally {
    clearTimeout(timeout);
  }
}

export default async () => {
  const store = getStore("scholar");

  let cached: ScholarStats | null = null;
  try {
    cached = await store.get(CACHE_KEY, { type: "json" });
  } catch {
    cached = null;
  }

  const isFresh =
    !!cached?.updatedAt && Date.now() - new Date(cached.updatedAt).getTime() < MAX_AGE_MS;

  if (isFresh) {
    return Response.json(cached, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  }

  try {
    const fresh = await fetchFromSerpApi();
    await store.setJSON(CACHE_KEY, fresh);
    return Response.json(fresh, {
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  } catch (err) {
    // Fetch failed — never break the site. Serve the last known-good cached
    // value if we have one, otherwise the static fallback baked into this file.
    const payload = cached ?? FALLBACK;
    return Response.json(
      { ...payload, staleReason: err instanceof Error ? err.message : String(err) },
      { headers: { "Cache-Control": "public, max-age=900" } },
    );
  }
};

export const config: Config = {
  path: "/api/scholar-stats",
};
