import type { RateCardPrice } from "@veralux/shared";
import {
  commitRateCard,
  ensureSeedRateCard,
  finishPriceFeedRun,
  getLatestPriceFeedRun,
  getLatestRateCard,
  insertPriceFeedRun,
  listPriceOverrides,
  seedPipelineCatalog,
} from "../pipelineDb";
import { runAllFeeds, type FeedResult } from "./feeds";
import { SEED_RATE_CARD } from "./seedRateCard";

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const STALE_MS = Number(process.env.PRICE_STALE_AFTER_MS || 24 * 60 * 60 * 1000);

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

function priceKey(p: RateCardPrice): string {
  return `${p.sku}::${p.unit}`;
}

function materialDiff(prev: RateCardPrice[], next: RateCardPrice[]): boolean {
  if (prev.length !== next.length) return true;
  const map = new Map(prev.map((p) => [priceKey(p), p.millicents]));
  for (const p of next) {
    if (map.get(priceKey(p)) !== p.millicents) return true;
  }
  return false;
}

function mergePrices(feeds: FeedResult[], last: RateCardPrice[], overrides: Awaited<ReturnType<typeof listPriceOverrides>>): RateCardPrice[] {
  const byKey = new Map<string, RateCardPrice>();
  for (const p of last.length ? last : SEED_RATE_CARD) {
    byKey.set(priceKey(p), { ...p });
  }
  for (const feed of feeds) {
    if (!feed.ok) continue;
    for (const p of feed.prices) {
      byKey.set(priceKey(p), {
        sku: p.sku,
        unit: p.unit,
        millicents: p.millicents,
        currency: "USD",
        source: p.source,
        asOf: p.asOf,
        stale: false,
      });
    }
  }
  const failed = new Set(feeds.filter((f) => !f.ok).map((f) => f.source));
  for (const p of byKey.values()) {
    if (failed.has(p.source.split("_")[0]) || failed.has(p.source)) {
      p.stale = true;
    }
  }
  for (const o of overrides) {
    byKey.set(`${o.sku}::${o.unit}`, {
      sku: o.sku,
      unit: o.unit as RateCardPrice["unit"],
      millicents: o.millicents,
      currency: "USD",
      source: "override",
      asOf: new Date().toISOString(),
      overridden: true,
    });
  }
  return [...byKey.values()];
}

export function isPriceRefreshEnabled(): boolean {
  const v = (process.env.PRICE_REFRESH_ENABLED || "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(v);
}

export function priceRefreshIntervalMs(): number {
  const n = Number(process.env.PRICE_REFRESH_INTERVAL_MS);
  return Number.isFinite(n) && n >= 60_000 ? n : DEFAULT_INTERVAL_MS;
}

export async function refreshPrices(trigger: "startup" | "timer" | "manual"): Promise<{ runId: string; status: string; committed: boolean }> {
  if (running && trigger !== "manual") {
    return { runId: "", status: "busy", committed: false };
  }
  running = true;
  await seedPipelineCatalog();
  await ensureSeedRateCard();
  const runId = await insertPriceFeedRun();
  try {
    const last = (await getLatestRateCard())?.prices || SEED_RATE_CARD;
    const feeds = isPriceRefreshEnabled()
      ? await runAllFeeds()
      : [];
    const overrides = await listPriceOverrides();
    const merged = mergePrices(feeds, last, overrides);
    const sources: Record<string, unknown> = {};
    const unmapped: unknown[] = [];
    for (const f of feeds) {
      sources[f.source] = { ok: f.ok, stale: f.stale, error: f.error, count: f.prices.length };
      unmapped.push(...f.unmapped.map((k) => ({ source: f.source, key: k })));
    }
    if (!isPriceRefreshEnabled()) {
      sources.disabled = { ok: true, stale: false, error: "PRICE_REFRESH_ENABLED=false" };
    }
    const failed = feeds.filter((f) => !f.ok && f.error !== "skipped_no_key");
    const status = !isPriceRefreshEnabled() ? "ok" : failed.length === 0 ? "ok" : failed.length === feeds.length ? "failed" : "partial";
    let rateCardId: string | null = null;
    let committed = false;
    if (status !== "failed" && materialDiff(last, merged)) {
      rateCardId = await commitRateCard(merged, sources);
      committed = true;
      console.log("[pricing] committed rate card", { runId, trigger, prices: merged.length });
    } else {
      const latest = await getLatestRateCard();
      rateCardId = latest?.id || null;
    }
    await finishPriceFeedRun(runId, status, sources, unmapped, failed.map((f) => f.error).filter(Boolean).join("; ") || null, rateCardId);
    return { runId, status, committed };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await finishPriceFeedRun(runId, "failed", {}, [], msg, null);
    console.error("[pricing] refresh failed", { runId, err: msg });
    return { runId, status: "failed", committed: false };
  } finally {
    running = false;
  }
}

export async function applyOverridesToLatestCard(): Promise<void> {
  const latest = await getLatestRateCard();
  const overrides = await listPriceOverrides();
  if (!latest) return;
  const merged = mergePrices([], latest.prices, overrides);
  if (materialDiff(latest.prices, merged)) {
    await commitRateCard(merged, { ...(latest.sources || {}), override: { ok: true } });
  }
}

export function freshnessFromRun(run: Record<string, unknown> | null): {
  refreshingEnabled: boolean;
  stale: boolean;
  lastSuccessAt: string | null;
  nextRefreshAt: string | null;
  sources: Record<string, unknown>;
} {
  const enabled = isPriceRefreshEnabled();
  const finished = run?.finishedAt ? new Date(String(run.finishedAt)).getTime() : 0;
  const stale = !enabled || !finished || Date.now() - finished > STALE_MS || run?.status === "failed";
  const next = enabled ? new Date((finished || Date.now()) + priceRefreshIntervalMs()).toISOString() : null;
  return {
    refreshingEnabled: enabled,
    stale,
    lastSuccessAt: finished ? new Date(finished).toISOString() : null,
    nextRefreshAt: next,
    sources: (run?.sources as Record<string, unknown>) || {},
  };
}

export function startPriceRefreshLoop(): void {
  if (timer) return;
  const interval = priceRefreshIntervalMs();
  void (async () => {
    try {
      const last = await getLatestPriceFeedRun();
      const finished = last?.finishedAt ? new Date(String(last.finishedAt)).getTime() : 0;
      if (!finished || Date.now() - finished >= interval) {
        await refreshPrices("startup");
      }
    } catch (e) {
      console.error("[pricing] startup refresh failed", e);
    }
  })();
  timer = setInterval(() => {
    void refreshPrices("timer");
  }, interval);
  timer.unref?.();
  console.log("[pricing] refresh loop started", { intervalMs: interval, enabled: isPriceRefreshEnabled() });
}

export function stopPriceRefreshLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
