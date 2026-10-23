import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/** Public Yahoo chart proxy for Nifty. CORS * — read-only market data, no cookies. */
const SYMBOL_OK = /^[\^A-Za-z0-9.=_-]{1,32}$/;
const INTERVAL_OK = new Set(["5m", "15m", "30m", "60m", "1h", "1d"]);
const RANGE_OK = new Set(["1d", "5d", "7d", "1mo", "30d", "60d", "3mo", "6mo", "1y", "2y", "5y"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "GET only" }), {
      status: 405,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(req.url);
    const symbol = url.searchParams.get("symbol") || "^NSEI";
    let interval = url.searchParams.get("interval") || "15m";
    if (interval === "1h") interval = "60m";
    let range = url.searchParams.get("range") || "1mo";
    if (range === "30d") range = "1mo";
    if (range === "60d") range = "3mo";

    if (!SYMBOL_OK.test(symbol) || !INTERVAL_OK.has(interval) || !RANGE_OK.has(range)) {
      return new Response(JSON.stringify({ error: "Bad symbol/interval/range" }), {
        status: 400,
        headers: { ...CORS, "Content-Type": "application/json" },
      });
    }

    const qs = `interval=${encodeURIComponent(interval)}&range=${encodeURIComponent(range)}&includePrePost=false`;
    const hosts = [
      "https://query1.finance.yahoo.com",
      "https://query2.finance.yahoo.com",
    ];
    let lastStatus = 0;
    let lastBody = "";
    for (const host of hosts) {
      const yahooUrl = `${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`;
      try {
        const yahoo = await fetch(yahooUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            Accept: "application/json",
          },
        });
        const body = await yahoo.text();
        lastStatus = yahoo.status;
        lastBody = body;
        if (yahoo.ok && body.includes('"result"')) {
          return new Response(body, {
            status: 200,
            headers: {
              ...CORS,
              "Content-Type": "application/json",
              "Cache-Control": "public, max-age=20",
            },
          });
        }
      } catch (_e) {
        /* try next host */
      }
    }

    return new Response(
      JSON.stringify({
        error: `Yahoo upstream failed (${lastStatus || "network"})`,
        detail: lastBody.slice(0, 200),
      }),
      { status: 502, headers: { ...CORS, "Content-Type": "application/json" } },
    );
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message || e) }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
