# nz-grocery-prices (MVP)

Prices a fixed basket at PAK'nSAVE, New World and Woolworths NZ store locations
on a schedule, and commits the results back to this repo as JSON
("git scraping").

## How it works

- **PAK'nSAVE / New World** share one Foodstuffs API. Flow (plain HTTPS, no browser):
  1. `POST /api/user/get-current-user` → anonymous JWT (~30 min)
  2. `GET /v1/edge/store` → store list
  3. `GET /v1/edge/store/{id}/product/{productId}` or `POST /v1/edge/search/paginated/products` → store-specific prices (in cents)
- **Woolworths** uses `GET /api/v1/products*` with header `x-requested-with: OnlineShopping.WebApp`. No auth. An anonymous session resolves to Woolworths' own default store; see [store targeting](#woolworths-store-targeting) to pin a specific one.

`src/scrape.mjs` walks `config/basket.json` × `config/stores.json`, writes
`data/latest.json`, and appends a dated snapshot under `data/history/`.

## Run it

Requires Node ≥ 18 (uses the built-in `fetch`). No dependencies.

```bash
npm run scrape                       # price the basket, write data/
npm run stores:foodstuffs -- auckland   # list store ids for config/stores.json
```

The GitHub Action ([.github/workflows/scrape.yml](.github/workflows/scrape.yml))
runs it daily at 06:00 NZ and commits any changes under `data/`.

## Configuration

### `config/stores.json`

Store locations to price. Foodstuffs entries need the store UUID (get them from
`npm run stores:foodstuffs`). Woolworths entries name an env var that may hold a
[store cookie](#woolworths-store-targeting).

### `config/basket.json`

Each item has a `label` and a per-retailer `lookup`:

| lookup | retailer | meaning |
| --- | --- | --- |
| `{ "productId": "5201479-EA-000" }` | paknsave / newworld | exact product (best — like-for-like) |
| `{ "sku": "282819" }` | woolworths | exact product |
| `{ "query": "anchor butter 500g" }` | any | free-text search, first hit wins (quick to add, noisier) |

A retailer with no lookup falls back to `{ query: item.query ?? item.label }`.
Foodstuffs `productId`s are shared between PAK'nSAVE and New World.

To find ids: `npm run stores:foodstuffs` for stores; for products, search on
each retailer's website and read the id from the product URL, or add the item
as a `query` first and copy the `productId` it resolves to out of
`data/latest.json`.

## Woolworths store targeting

Without a cookie, every Woolworths "store" returns the same default-session
price. To price a specific store:

1. In a browser, go to woolworths.co.nz and select your store.
2. DevTools → Network → click any `/api/v1/...` request → Request Headers → copy the whole `cookie:` value.
3. Put it in the env var named by the Woolworths entry in `config/stores.json`
   (`WOOLWORTHS_COOKIE` by default). Locally: `WOOLWORTHS_COOKIE='...' npm run scrape`.
   In CI: repo Settings → Secrets → Actions → `WOOLWORTHS_COOKIE`.

The scraper records whichever store the API reports, so `data/latest.json`
always says which store a price came from. Cookies expire after a while and
need re-copying.

## Caveats

- Woolworths is behind Akamai Bot Manager; the Foodstuffs storefront is behind
  Cloudflare (the API hosts used here are not). Keep the schedule infrequent
  and the basket small. The scraper retries with backoff and paces calls
  (`SCRAPE_DELAY_MS`, default 700 ms).
- The Foodstuffs search API caps results at ~1000 hits / 20 pages — fine for a
  curated basket, not for full-catalogue crawling.
- Both retailers' terms discourage scraping. This is a low-volume personal
  project; treat the data accordingly.
- Cross-retailer matching is by hand (the `lookup` per item). There is no
  shared product id; barcodes mostly line up (`data/latest.json` records them
  where available) and could drive matching later.
