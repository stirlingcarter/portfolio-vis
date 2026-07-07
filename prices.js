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

  return { isCrypto, quote, quoteMany, CRYPTO_IDS };
})();
