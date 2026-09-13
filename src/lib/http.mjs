// Minimal fetch wrapper: per-attempt timeout, GET retry with backoff, and a
// JSON parser that turns a WAF/HTML challenge served with status 200 into a
// clear error instead of a bare "Unexpected token <".

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_BODY_BYTES = 20 * 1024 * 1024;

export class HttpError extends Error {
  constructor(message, { status, bodyPrefix } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.bodyPrefix = bodyPrefix;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.timeout=15000]  per-attempt timeout in ms
 * @param {number} [options.retries=3]      extra attempts for retryable GETs
 * @param {string} [options.operation]      label used in error messages
 */
export async function request(url, options = {}) {
  const { timeout = 15000, retries = 3, operation = url, ...init } = options;
  const method = (init.method ?? "GET").toUpperCase();
  const canRetry = method === "GET";
  const attempts = canRetry ? retries + 1 : 1;

  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      if (RETRYABLE_STATUS.has(res.status) && attempt < attempts - 1) {
        await res.body?.cancel?.();
        await sleep(backoff(attempt, res.headers.get("retry-after")));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      const retryable =
        err.name === "AbortError" ||
        ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(err.code);
      if (!canRetry || !retryable || attempt === attempts - 1) {
        throw new HttpError(`${operation}: request failed (${err.name}${err.code ? ` ${err.code}` : ""})`, {});
      }
      await sleep(backoff(attempt));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function backoff(attempt, retryAfterHeader) {
  const headerSeconds = Number(retryAfterHeader);
  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.min(headerSeconds * 1000, 30000);
  }
  const base = Math.min(1000 * 2 ** attempt, 30000);
  return base + Math.random() * base * 0.2;
}

export async function requestJson(url, options = {}) {
  const operation = options.operation ?? url;
  const res = await request(url, options);
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw new HttpError(`${operation}: response body too large (${contentLength} bytes)`, { status: res.status });
  }
  const text = await res.text();
  if (!res.ok) {
    throw new HttpError(`${operation}: HTTP ${res.status} ${res.statusText}`, {
      status: res.status,
      bodyPrefix: text.slice(0, 200),
    });
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json") && !looksLikeJson(text)) {
    throw new HttpError(
      `${operation}: expected JSON but got ${contentType || "unknown content-type"} ` +
        `(status ${res.status}). Body starts: ${text.slice(0, 120).replace(/\s+/g, " ")}`,
      { status: res.status, bodyPrefix: text.slice(0, 200) },
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(`${operation}: response was not valid JSON. Body starts: ${text.slice(0, 120)}`, {
      status: res.status,
      bodyPrefix: text.slice(0, 200),
    });
  }
}

function looksLikeJson(text) {
  const t = text.trimStart();
  return t.startsWith("{") || t.startsWith("[");
}
