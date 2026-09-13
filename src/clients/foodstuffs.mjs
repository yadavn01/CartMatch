// Foodstuffs platform client (PAK'nSAVE + New World share one e-commerce API).
//
// Flow, all plain HTTPS, no browser:
//   1. POST {webOrigin}/api/user/get-current-user  -> anonymous JWT (~30 min)
//   2. GET  {apiOrigin}/v1/edge/store              -> store list
//   3. GET  {apiOrigin}/v1/edge/store/{id}/product/{productId}  -> one product, store-priced
//      POST {apiOrigin}/v1/edge/search/paginated/products       -> search, store-scoped
//
// Prices come back in integer cents.

import { randomUUID } from "node:crypto";
import { requestJson } from "../lib/http.mjs";

const USER_AGENT = "grocery-price-mvp/0.1 (+https://github.com/)";

const BANNERS = {
  paknsave: {
    storeBanner: "PNS",
    webOrigin: "https://www.paknsave.co.nz",
    apiOrigin: "https://api-prod.paknsave.co.nz",
  },
  newworld: {
    storeBanner: "MNW",
    webOrigin: "https://www.newworld.co.nz",
    apiOrigin: "https://api-prod.newworld.co.nz",
  },
};

export class FoodstuffsClient {
  #token = null;
  #tokenExpiresAt = 0;
  #fingerprint = randomUUID().replaceAll("-", "");

  constructor(banner) {
    const config = BANNERS[banner];
    if (!config) throw new Error(`Unknown Foodstuffs banner: ${banner}`);
    this.banner = banner;
    this.config = config;
  }

  async #accessToken() {
    if (this.#token && Date.now() < this.#tokenExpiresAt - 60_000) return this.#token;
    const session = await requestJson(`${this.config.webOrigin}/api/user/get-current-user`, {
      method: "POST",
      operation: `${this.banner} auth`,
      headers: { "content-type": "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ fingerprintUser: this.#fingerprint, fingerprintGuest: USER_AGENT }),
    });
    if (!session?.access_token) throw new Error(`${this.banner} auth: no access_token in response`);
    const expiresAt = Date.parse(session.expires_time);
    this.#token = session.access_token;
    this.#tokenExpiresAt = Number.isFinite(expiresAt) ? expiresAt : Date.now() + 25 * 60_000;
    return this.#token;
  }

  async #edge(path, init = {}) {
    const token = await this.#accessToken();
    return requestJson(`${this.config.apiOrigin}${path}`, {
      ...init,
      operation: `${this.banner} ${path}`,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        origin: this.config.webOrigin,
        referer: `${this.config.webOrigin}/`,
        "user-agent": USER_AGENT,
        ...init.headers,
      },
    });
  }

  /** All physical stores for this banner: [{ id, name, address, region }]. */
  async listStores() {
    const result = await this.#edge("/v1/edge/store");
    if (!Array.isArray(result?.stores)) throw new Error(`${this.banner} store list: no stores array`);
    return result.stores
      .filter((s) => (s.banner ?? "").toUpperCase() === this.config.storeBanner)
      .map((s) => ({ id: s.id, name: s.name, address: s.address ?? "", region: s.region ?? "" }));
  }

  /**
   * One product priced for a specific store.
   * @returns {{ productId, name, brand, priceCents, unitPrice, barcode, onSpecial }}
   */
  async getProduct(storeId, productId) {
    const p = await this.#edge(`/v1/edge/store/${storeId}/product/${encodeURIComponent(productId)}`);
    const priceCents = firstInt(p.price, p.nonLoyaltyCardPrice);
    if (priceCents == null) throw new Error(`${this.banner} product ${productId}: no usable price`);
    return {
      productId: p.productId ?? productId,
      name: [p.brand, p.name].filter(Boolean).join(" ").trim() || p.name || productId,
      brand: p.brand ?? "",
      priceCents,
      unitPrice: comparativeString(p.comparativePricePerUnit, p.comparativeUnitQuantityUoM),
      barcode: typeof p.sku === "string" ? p.sku : "",
      onSpecial: Number.isInteger(p.nonLoyaltyCardPrice) && p.price < p.nonLoyaltyCardPrice,
    };
  }

  /** Free-text search scoped to a store; returns normalised hits (best first). */
  async search(storeId, query, { region = "NI", hitsPerPage = 5 } = {}) {
    const body = {
      algoliaQuery: {
        attributesToHighlight: [],
        facets: ["brand"],
        filters: `stores:${storeId}`,
        hitsPerPage,
        maxValuesPerFacet: 100,
        page: 0,
        query,
      },
      algoliaFacetQueries: [],
      storeId,
      hitsPerPage,
      page: 0,
      sortOrder: `${region}_POPULARITY_ASC`,
      tobaccoQuery: false,
      precisionMedia: { adDomain: "CATEGORY_PAGE", adPositions: [], publishImpressionEvent: false, disableAds: true },
    };
    const result = await this.#edge("/v1/edge/search/paginated/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const products = Array.isArray(result?.products) ? result.products : [];
    return products
      .map((p) => {
        const priceCents = firstInt(p.price, p.singlePrice?.price, p.multiPrice?.price);
        if (priceCents == null || typeof p.productId !== "string") return null;
        const cmp = p.singlePrice?.comparativePrice;
        return {
          productId: p.productId,
          name: [p.brand, p.name, p.displayName].filter(Boolean).join(" ").trim(),
          brand: p.brand ?? "",
          priceCents,
          unitPrice: cmp ? comparativeString(cmp.pricePerUnit, cmp.unitQuantityUom) : "",
          barcode: "",
          onSpecial: Array.isArray(p.promotions) && p.promotions.length > 0,
        };
      })
      .filter(Boolean);
  }
}

function firstInt(...values) {
  for (const v of values) if (Number.isInteger(v)) return v;
  return null;
}

function comparativeString(perUnitCents, uom) {
  if (!Number.isFinite(perUnitCents) || !uom) return "";
  return `$${(perUnitCents / 100).toFixed(2)}/${uom}`;
}
