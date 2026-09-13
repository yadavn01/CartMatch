// Price a fixed basket across configured store locations and write the results
// to data/latest.json plus a dated snapshot in data/history/.
//
//   npm run scrape

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { FoodstuffsClient } from "./clients/foodstuffs.mjs";
import { WoolworthsClient } from "./clients/woolworths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS ?? 700); // politeness between calls

async function main() {
  const stores = JSON.parse(await readFile(join(ROOT, "config/stores.json"), "utf8"));
  const basket = JSON.parse(await readFile(join(ROOT, "config/basket.json"), "utf8"));
  const items = basket.items ?? [];

  const targets = await buildTargets(stores); // [{ storeKey, retailer, storeName, lookup }]
  console.log(`Pricing ${items.length} items across ${targets.length} store(s)\n`);

  const storeIndex = {};
  for (const t of targets) storeIndex[t.storeKey] = { retailer: t.retailer, name: t.storeName };

  const results = [];
  for (const item of items) {
    const query = item.query ?? item.label;
    const prices = [];
    for (const t of targets) {
      const lookup = item.lookups?.[t.retailer] ?? { query };
      try {
        const priced = await t.lookup(lookup, query);
        prices.push({ ...priced, store: t.storeKey, storeName: t.storeName, retailer: t.retailer, ok: true });
        console.log(`  ok   ${item.key.padEnd(22)} ${t.storeName.padEnd(28)} $${(priced.priceCents / 100).toFixed(2)}`);
      } catch (err) {
        prices.push({ store: t.storeKey, storeName: t.storeName, retailer: t.retailer, ok: false, error: String(err.message ?? err) });
        console.log(`  FAIL ${item.key.padEnd(22)} ${t.storeName.padEnd(28)} ${err.message ?? err}`);
      }
      await sleep(DELAY_MS);
    }
    const ok = prices.filter((p) => p.ok);
    const cheapest = ok.length ? ok.reduce((a, b) => (b.priceCents < a.priceCents ? b : a)) : null;
    results.push({
      key: item.key,
      label: item.label,
      cheapest: cheapest && { store: cheapest.store, storeName: cheapest.storeName, priceCents: cheapest.priceCents },
      spreadCents: ok.length ? Math.max(...ok.map((p) => p.priceCents)) - Math.min(...ok.map((p) => p.priceCents)) : null,
      prices,
    });
  }

  const snapshot = {
    scrapedAt: new Date().toISOString(),
    stores: storeIndex,
    items: results,
  };

  const date = snapshot.scrapedAt.slice(0, 10);
  await mkdir(join(ROOT, "data/history"), { recursive: true });
  await writeFile(join(ROOT, "data/latest.json"), JSON.stringify(snapshot, null, 2) + "\n");
  await writeFile(join(ROOT, `data/history/${date}.json`), JSON.stringify(snapshot, null, 2) + "\n");

  printSummary(results);

  const totalCells = results.length * targets.length;
  const failed = results.reduce((n, r) => n + r.prices.filter((p) => !p.ok).length, 0);
  console.log(`\nWrote data/latest.json and data/history/${date}.json`);
  if (failed) console.log(`${failed}/${totalCells} lookups failed`);
  if (failed === totalCells && totalCells > 0) process.exit(1); // nothing worked -> fail the run
}

async function buildTargets(stores) {
  const targets = [];

  for (const banner of ["paknsave", "newworld"]) {
    const configured = stores[banner] ?? [];
    if (!configured.length) continue;
    const client = new FoodstuffsClient(banner);
    for (const store of configured) {
      targets.push({
        storeKey: `${banner}:${store.id}`,
        retailer: banner,
        storeName: store.name ?? `${banner} ${store.id}`,
        lookup: withSearchFallback(
          (id) => client.getProduct(store.id, id),
          async (q) => (await client.search(store.id, q))[0],
        ),
      });
    }
  }

  for (const store of stores.woolworths ?? []) {
    const cookie = store.cookieEnv ? process.env[store.cookieEnv] : store.cookie;
    const client = new WoolworthsClient({ cookie });
    const resolved = await client.currentStore().catch(() => ({ id: "", name: store.name }));
    const id = resolved.id || "session";
    targets.push({
      storeKey: `woolworths:${id}`,
      retailer: "woolworths",
      storeName: resolved.name || store.name || "Woolworths",
      lookup: withSearchFallback(
        (sku) => client.getProduct(sku),
        async (q) => (await client.search(q)).hits[0],
      ),
    });
  }

  return targets;
}

// Returns a lookup(lookup, fallbackQuery) that tries the pinned id first and
// falls back to a search when the product isn't stocked at that store (404) or
// no id was given. The `matchedBy` field records which path produced the price.
function withSearchFallback(byId, bySearch) {
  return async (lookup, fallbackQuery) => {
    const id = lookup.productId ?? lookup.sku;
    if (id) {
      try {
        return { matchedBy: "id", ...(await byId(id)) };
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    }
    const query = lookup.query ?? fallbackQuery;
    const hit = await bySearch(query);
    if (!hit) throw new Error(`${id ? `id ${id} not stocked; ` : ""}no search hit for "${query}"`);
    return { matchedBy: id ? "search-fallback" : "search", ...hit };
  };
}

function printSummary(results) {
  console.log("\nSummary (cheapest store per item):");
  for (const r of results) {
    if (!r.cheapest) {
      console.log(`  ${r.label.padEnd(34)} — no prices`);
      continue;
    }
    const spread = r.spreadCents ? ` (spread $${(r.spreadCents / 100).toFixed(2)})` : "";
    console.log(
      `  ${r.label.padEnd(34)} $${(r.cheapest.priceCents / 100).toFixed(2)} @ ${r.cheapest.storeName}${spread}`,
    );
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
