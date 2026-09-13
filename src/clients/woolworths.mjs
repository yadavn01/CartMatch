// Woolworths NZ (formerly Countdown) client.
//
// Plain GETs against /api/v1/products*. The header `x-requested-with:
// OnlineShopping.WebApp` is what makes the API answer JSON instead of the SPA
// shell. No auth.
//
// Store targeting: an anonymous session resolves to Woolworths' own default
// store (currently Glenfield, id 9171). To price a specific store, set
// WOOLWORTHS_COOKIE to a cookie string copied from a browser where you have
// selected that store (DevTools > Network > any /api/v1 request > Request
// Headers > cookie). The scraper records whichever store the API reports back,
// so the output always says which store a price came from.
//
// Woolworths prices come back in dollars; we convert to integer cents.

import { requestJson } from "../lib/http.mjs";

const ORIGIN = "https://www.woolworths.co.nz";
// Woolworths sits behind Akamai Bot Manager. A non-browser User-Agent or noisy
// headers (e.g. content-type on a GET) get connections greylisted / reset, so
// keep the request shape close to what a browser tab sends.
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export class WoolworthsClient {
  constructor({ cookie } = {}) {
    this.cookie = cookie || process.env.WOOLWORTHS_COOKIE || "";
  }

  #headers(extra = {}) {
    return {
      accept: "application/json",
      "user-agent": USER_AGENT,
      "x-requested-with": "OnlineShopping.WebApp",
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...extra,
    };
  }

  /** { id, name } of the store the current session resolves to. */
  async currentStore() {
    const data = await requestJson(`${ORIGIN}/api/v1/products?target=search&search=milk&size=1`, {
      operation: "woolworths session store",
      headers: this.#headers(),
    });
    return storeFromContext(data);
  }

  /**
   * One product by stockcode (sku).
   * @returns {{ productId, name, brand, priceCents, unitPrice, barcode, onSpecial, store }}
   */
  async getProduct(sku) {
    const p = await requestJson(`${ORIGIN}/api/v1/products/${encodeURIComponent(sku)}`, {
      operation: `woolworths product ${sku}`,
      headers: this.#headers(),
    });
    return normaliseProduct(p);
  }

  /** Free-text search; returns normalised hits (best first) plus the session store. */
  async search(query, { size = 5 } = {}) {
    const url = `${ORIGIN}/api/v1/products?target=search&size=${size}&search=${encodeURIComponent(query)}`;
    const data = await requestJson(url, {
      operation: `woolworths search "${query}"`,
      headers: this.#headers(),
    });
    const items = Array.isArray(data?.products?.items) ? data.products.items : [];
    return {
      store: storeFromContext(data),
      hits: items.map(normaliseProduct).filter((h) => h.priceCents != null),
    };
  }
}

function normaliseProduct(p) {
  const price = p.price ?? {};
  const salePrice = Number(price.salePrice ?? price.originalPrice);
  const priceCents = Number.isFinite(salePrice) ? Math.round(salePrice * 100) : null;
  const size = p.size ?? {};
  // Woolworths `name` already leads with the brand, so use it as-is.
  return {
    productId: String(p.sku ?? ""),
    name: (p.name ?? String(p.sku ?? "")).trim(),
    brand: p.brand ?? "",
    priceCents,
    unitPrice:
      Number.isFinite(size.cupPrice) && size.cupMeasure ? `$${Number(size.cupPrice).toFixed(2)}/${size.cupMeasure}` : "",
    barcode: typeof p.barcode === "string" ? p.barcode : "",
    onSpecial: Boolean(price.isSpecial || price.isClubPrice || p.productTag?.tagType === "IsSpecial"),
  };
}

function storeFromContext(payload) {
  const f = payload?.context?.fulfilment ?? {};
  return {
    id: f.fulfilmentStoreId != null ? String(f.fulfilmentStoreId) : "",
    name: f.address ? `Woolworths ${f.address}` : "Woolworths (session store)",
  };
}
