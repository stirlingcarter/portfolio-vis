/* ============================================================
   PRICE LAYER — live quotes for a ticker. No DOM, no state.
   Pure async lookups the UI can call to stamp Value = shares × price.

   Two free, keyless sources:
     • Stocks / ETFs (QQQ, VOO, VTI, …) → Yahoo Finance chart endpoint.
       Yahoo sends no CORS headers, so we try it directly first (works when
       something upstream is permissive) then fall back through public
       CORS proxies. Any single one being down is survivable.
     • Crypto (BTC, ETH, SOL, …)        → CoinGecko simple-price API,
       which is CORS-enabled (access-control-allow-origin: *) and needs no key.

   Every resolver THROWS on failure. That is the contract: the caller is
   expected to fall back to a user-entered price when nothing resolves.
   ============================================================ */

const Prices = (() => {

  // Ticker → CoinGecko coin id. Extend freely; anything not here is treated
  // as a stock/ETF symbol and sent to Yahoo.
  const CRYPTO_IDS = {
    BTC: "bitcoin",   XBT: "bitcoin",
    ETH: "ethereum",
    SOL: "solana",    ADA: "cardano",   DOGE: "dogecoin",
    XRP: "ripple",    LTC: "litecoin",  BCH: "bitcoin-cash",
    DOT: "polkadot",  MATIC: "matic-network", AVAX: "avalanche-2",
    LINK: "chainlink", UNI: "uniswap",  ATOM: "cosmos",
    BNB: "binancecoin", USDC: "usd-coin", USDT: "tether",
    XLM: "stellar",   XMR: "monero",    TRX: "tron",
    NEAR: "near",     APT: "aptos",     ARB: "arbitrum", OP: "optimism"
  };

  const norm = t => String(t || "").trim().toUpperCase();
  const fixedQuote = sym => sym === "USD"
    ? { ticker: "USD", price: 1, currency: "USD", source: "Fixed USD" }
    : null;
  function isCrypto(ticker) { return norm(ticker) in CRYPTO_IDS; }

  // Ways to fetch a cross-origin URL, tried in order until one works. Yahoo
  // sends no CORS headers, so the browser blocks a direct hit — we go through a
  // public CORS proxy. Direct is kept first (fails fast; succeeds if the app is
  // ever served same-origin behind its own proxy). corsproxy.io returns the
  // upstream body verbatim; r.jina.ai wraps it in text, so its JSON is dug out
  // by brace-extraction below. Any one being down is survivable.
  const PROXIES = [
    url => url,
    url => "https://corsproxy.io/?url=" + encodeURIComponent(url),
    url => "https://r.jina.ai/" + url
  ];

  const TIMEOUT_MS = 8000;

  async function fetchTextWithTimeout(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJSONWithTimeout(url) {
    return JSON.parse(await fetchTextWithTimeout(url));
  }

  // Parse JSON out of a proxy response — tolerant of proxies (r.jina.ai) that
  // wrap the upstream body in surrounding text.
  function parseLooseJSON(text) {
    try { return JSON.parse(text); } catch {}
    const start = text.indexOf("{"), end = text.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));
    throw new Error("no JSON in response");
  }

  // Fetch a JSON target, trying direct then each proxy until one works.
  async function fetchJSONResilient(targetUrl) {
    let lastErr;
    for (const proxy of PROXIES) {
      try {
        return parseLooseJSON(await fetchTextWithTimeout(proxy(targetUrl)));
      } catch (err) {
        lastErr = err;   // try the next strategy
      }
    }
    throw lastErr || new Error("all fetch strategies failed");
  }

  /* ---------- stock / ETF via Yahoo ---------- */

  async function stockQuote(ticker) {
    const sym = norm(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`;
    const data = await fetchJSONResilient(url);
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice;
    if (typeof price !== "number" || !isFinite(price)) {
      throw new Error(`no price for ${sym}`);
    }
    return { ticker: sym, price, currency: meta.currency || "USD", source: "Yahoo Finance" };
  }

  /* ---------- historical price series ---------- */

  // Look-back ranges for the holdings-history chart. Each maps to ONE upstream
  // request per ticker: Yahoo's chart endpoint takes interval/range pairs, and
  // CoinGecko's market_chart takes a day count (its keyless tier auto-picks
  // 5-minutely / hourly / daily granularity). `coingeckoDays: null` marks a
  // range crypto cannot serve — CoinGecko's free tier hard-caps historical
  // data at the past 365 days. `ttlMs` is how long the UI may reuse a cached
  // series before refetching.
  const HISTORY_RANGES = [
    { key: "1h",  label: "1H",  ms: 3600e3,               yahoo: { range: "1d",  interval: "2m"  }, coingeckoDays: "1",   ttlMs: 3 * 60e3 },
    { key: "24h", label: "24H", ms: 24 * 3600e3,          yahoo: { range: "5d",  interval: "15m" }, coingeckoDays: "1",   ttlMs: 10 * 60e3 },
    { key: "3d",  label: "3D",  ms: 3 * 86400e3,          yahoo: { range: "5d",  interval: "30m" }, coingeckoDays: "3",   ttlMs: 30 * 60e3 },
    { key: "1w",  label: "1W",  ms: 7 * 86400e3,          yahoo: { range: "1mo", interval: "1h"  }, coingeckoDays: "7",   ttlMs: 3600e3 },
    { key: "2w",  label: "2W",  ms: 14 * 86400e3,         yahoo: { range: "1mo", interval: "1h"  }, coingeckoDays: "14",  ttlMs: 3600e3 },
    { key: "1m",  label: "1M",  ms: 30 * 86400e3,         yahoo: { range: "3mo", interval: "1d"  }, coingeckoDays: "30",  ttlMs: 3 * 3600e3 },
    { key: "1y",  label: "1Y",  ms: 365 * 86400e3,        yahoo: { range: "1y",  interval: "1d"  }, coingeckoDays: "365", ttlMs: 86400e3 },
    { key: "5y",  label: "5Y",  ms: 5 * 365 * 86400e3,    yahoo: { range: "5y",  interval: "1wk" }, coingeckoDays: null,  ttlMs: 3 * 86400e3 },
    { key: "10y", label: "10Y", ms: 10 * 365 * 86400e3,   yahoo: { range: "10y", interval: "1mo" }, coingeckoDays: null,  ttlMs: 3 * 86400e3 },
    { key: "20y", label: "20Y", ms: 20 * 365 * 86400e3,   yahoo: { range: "max", interval: "1mo" }, coingeckoDays: null,  ttlMs: 3 * 86400e3 }
  ];

  function historyRange(rangeKey) {
    const spec = HISTORY_RANGES.find(r => r.key === rangeKey);
    if (!spec) throw new Error(`unknown history range "${rangeKey}"`);
    return spec;
  }

  // Yahoo history: one call returns the whole series for the range.
  // Points are [msTimestamp, closePrice]; null candles are dropped, and the
  // live regularMarketPrice is appended so the series ends at "now".
  async function stockHistory(ticker, spec) {
    const sym = norm(ticker);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}` +
      `?interval=${spec.yahoo.interval}&range=${spec.yahoo.range}`;
    const data = await fetchJSONResilient(url);
    const result = data?.chart?.result?.[0];
    const ts = result?.timestamp;
    const closes = result?.indicators?.quote?.[0]?.close;
    if (!Array.isArray(ts) || !Array.isArray(closes)) throw new Error(`no history for ${sym}`);
    const points = [];
    for (let i = 0; i < ts.length; i++) {
      const price = closes[i];
      if (typeof price === "number" && isFinite(price)) points.push([ts[i] * 1000, price]);
    }
    const live = result?.meta?.regularMarketPrice;
    const liveAt = (Number(result?.meta?.regularMarketTime) || 0) * 1000;
    if (typeof live === "number" && isFinite(live) && points.length && liveAt > points[points.length - 1][0]) {
      points.push([liveAt, live]);
    }
    if (points.length < 2) throw new Error(`no history for ${sym}`);
    return points;
  }

  // CoinGecko history. The keyless/Demo tier only serves the past 365 days, so
  // ranges beyond that throw immediately (no network call).
  async function cryptoHistory(ticker, spec) {
    const sym = norm(ticker);
    const id = CRYPTO_IDS[sym];
    if (!id) throw new Error(`unknown coin ${sym}`);
    if (!spec.coingeckoDays) throw new Error(`${sym}: CoinGecko free data stops at 1y look-back`);
    const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart` +
      `?vs_currency=usd&days=${spec.coingeckoDays}`;
    const data = await fetchJSONWithTimeout(url);
    const points = (Array.isArray(data?.prices) ? data.prices : [])
      .filter(p => Array.isArray(p) && typeof p[1] === "number" && isFinite(p[1]))
      .map(p => [Number(p[0]), p[1]]);
    if (points.length < 2) throw new Error(`no history for ${sym}`);
    return points;
  }

  // Resolve one ticker's price history for a range →
  // { ticker, points: [[ms, price]…], fetchedAt, source }. Throws on failure.
  async function history(ticker, rangeKey) {
    const sym = norm(ticker);
    const spec = historyRange(rangeKey);
    if (!sym) throw new Error("empty ticker");
    const now = Date.now();
    if (fixedQuote(sym)) {
      return { ticker: sym, points: [[now - spec.ms, 1], [now, 1]], fetchedAt: now, source: "Fixed USD" };
    }
    if (sym in CRYPTO_IDS) {
      return { ticker: sym, points: await cryptoHistory(sym, spec), fetchedAt: Date.now(), source: "CoinGecko" };
    }
    return { ticker: sym, points: await stockHistory(sym, spec), fetchedAt: Date.now(), source: "Yahoo Finance" };
  }

  // Resolve many tickers' histories → { results: Map, errors: Map }. Stocks go
  // in parallel (one Yahoo call each); crypto goes sequentially to stay well
  // inside CoinGecko's keyless IP-based rate limiting.
  async function historyMany(tickers, rangeKey) {
    historyRange(rangeKey);   // validate up front
    const syms = [...new Set(tickers.map(norm).filter(Boolean))];
    const results = new Map();
    const errors = new Map();
    const cryptoSyms = syms.filter(s => !fixedQuote(s) && s in CRYPTO_IDS);
    const otherSyms = syms.filter(s => !cryptoSyms.includes(s));

    const otherP = Promise.all(otherSyms.map(sym =>
      history(sym, rangeKey).then(h => results.set(sym, h)).catch(err => errors.set(sym, err))
    ));
    const cryptoP = (async () => {
      for (const sym of cryptoSyms) {
        try { results.set(sym, await history(sym, rangeKey)); }
        catch (err) { errors.set(sym, err); }
      }
    })();
    await Promise.all([otherP, cryptoP]);
    return { results, errors };
  }

  /* ---------- crypto via CoinGecko ---------- */

  // Batch-friendly: one CoinGecko call resolves many coins at once.
  async function cryptoQuotes(tickers) {
    const syms = tickers.map(norm).filter(t => t in CRYPTO_IDS);
    if (syms.length === 0) return new Map();
    const ids = [...new Set(syms.map(t => CRYPTO_IDS[t]))];
    const url = "https://api.coingecko.com/api/v3/simple/price?ids=" +
      encodeURIComponent(ids.join(",")) + "&vs_currencies=usd";
    const data = await fetchJSONWithTimeout(url);   // CoinGecko is CORS-enabled — no proxy needed
    const out = new Map();
    syms.forEach(sym => {
      const price = data?.[CRYPTO_IDS[sym]]?.usd;
      if (typeof price === "number" && isFinite(price)) {
        out.set(sym, { ticker: sym, price, currency: "USD", source: "CoinGecko" });
      }
    });
    return out;
  }

  /* ---------- public API ---------- */

  // Resolve one ticker → { ticker, price, currency, source }. Throws if unknown.
  async function quote(ticker) {
    const sym = norm(ticker);
    if (!sym) throw new Error("empty ticker");
    const fixed = fixedQuote(sym);
    if (fixed) return fixed;
    if (sym in CRYPTO_IDS) {
      const m = await cryptoQuotes([sym]);
      if (m.has(sym)) return m.get(sym);
      throw new Error(`no price for ${sym}`);
    }
    return stockQuote(sym);
  }

  // Resolve many tickers → Map<ticker, {price, source, ...}>. Missing/failed
  // tickers are simply absent from the map (never throws for a partial result).
  // Crypto is fetched in a single batched call; stocks in parallel.
  async function quoteMany(tickers) {
    const syms = [...new Set(tickers.map(norm).filter(Boolean))];
    const cryptoSyms = syms.filter(t => !fixedQuote(t) && t in CRYPTO_IDS);
    const stockSyms = syms.filter(t => !fixedQuote(t) && !(t in CRYPTO_IDS));

    const results = new Map();
    syms.forEach(sym => {
      const fixed = fixedQuote(sym);
      if (fixed) results.set(sym, fixed);
    });

    const cryptoP = cryptoQuotes(cryptoSyms)
      .then(m => m.forEach((v, k) => results.set(k, v)))
      .catch(() => {});

    const stockP = Promise.all(stockSyms.map(sym =>
      stockQuote(sym).then(q => results.set(sym, q)).catch(() => {})
    ));

    await Promise.all([cryptoP, stockP]);
    return results;
  }

  return { isCrypto, quote, quoteMany, history, historyMany, HISTORY_RANGES, CRYPTO_IDS };
})();
