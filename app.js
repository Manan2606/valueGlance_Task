/* Stock Price Dashboard (JS + React via CDN + Tailwind via CDN)
   - Responsive table: Symbol | Price | Change %
   - Search comma-separated tickers
   - Sorting, loading spinner, error handling
   - Optional 1-month chart per symbol (Chart.js)
   - Data provider:
       * Finnhub (set token in config.js)
       * Yahoo Finance fallback (no key) */

const { useEffect, useMemo, useRef, useState } = React;
const h = React.createElement;

// ---------- CONFIG ----------
const CFG = (window.APP_CONFIG || {});
const PROVIDER =
  (CFG.PROVIDER && CFG.PROVIDER !== "auto")
    ? CFG.PROVIDER
    : (CFG.FINNHUB_TOKEN ? "finnhub" : "yahoo");

// ---------- API HELPERS ----------
async function fetchQuotesYahoo(symbols) {
  if (!symbols.length) return [];
  const url =
    "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
    encodeURIComponent(symbols.join(","));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo quotes failed (${res.status})`);
  const j = await res.json();
  const arr = j?.quoteResponse?.result ?? [];
  return arr.map((r) => ({
    symbol: r.symbol,
    price: r.regularMarketPrice,
    changePercent: r.regularMarketChangePercent,
  }));
}

async function fetchChartYahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=1mo&interval=1d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Yahoo chart failed (${res.status})`);
  const j = await res.json();
  const r = j?.chart?.result?.[0];
  if (!r) throw new Error("No Yahoo chart data");
  const labels = (r.timestamp || []).map((t) =>
    new Date(t * 1000).toLocaleDateString()
  );
  const values = r?.indicators?.quote?.[0]?.close || [];
  return { labels, values };
}

async function fetchQuoteFinnhub(symbol) {
  const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(
    symbol
  )}&token=${CFG.FINNHUB_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub quote failed (${res.status})`);
  const j = await res.json();
  return { symbol, price: j.c, changePercent: j.dp };
}

async function fetchQuotesFinnhub(symbols) {
  const tasks = symbols.map(fetchQuoteFinnhub);
  const results = await Promise.allSettled(tasks);
  const ok = [];
  const errs = [];
  for (const r of results) {
    if (r.status === "fulfilled") ok.push(r.value);
    else errs.push(r.reason?.message || "failed");
  }
  if (!ok.length && errs.length) {
    throw new Error(`All Finnhub requests failed: ${errs.join("; ").slice(0, 180)}`);
  }
  return ok;
}

async function fetchChartFinnhub(symbol) {
  const to = Math.floor(Date.now() / 1000);
  const from = to - 60 * 60 * 24 * 30;
  const url = `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(
    symbol
  )}&resolution=D&from=${from}&to=${to}&token=${CFG.FINNHUB_TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Finnhub chart failed (${res.status})`);
  const j = await res.json();
  if (j.s !== "ok") throw new Error("No Finnhub chart data");
  const labels = j.t.map((ts) => new Date(ts * 1000).toLocaleDateString());
  const values = j.c;
  return { labels, values };
}

async function fetchQuotes(symbols) {
  return PROVIDER === "finnhub"
    ? fetchQuotesFinnhub(symbols)
    : fetchQuotesYahoo(symbols);
}
async function fetchChartData(symbol) {
  return PROVIDER === "finnhub"
    ? fetchChartFinnhub(symbol)
    : fetchChartYahoo(symbol);
}

// ---------- UI BITS ----------
function Spinner({ small = false }) {
  const size = small ? "h-4 w-4" : "h-8 w-8";
  return h(
    "svg",
    { className: `animate-spin ${size} text-blue-500 mx-auto`, viewBox: "0 0 24 24" },
    h("circle", { className: "opacity-25", cx: 12, cy: 12, r: 10, stroke: "currentColor", strokeWidth: 4 }),
    h("path", { className: "opacity-75", fill: "currentColor", d: "M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" })
  );
}

function StockChart({ symbol, data }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!data || !ref.current) return;
    const ctx = ref.current.getContext("2d");
    if (!ctx) return;
    if (ref.current._chart) ref.current._chart.destroy();
    const chart = new Chart(ctx, {
      type: "line",
      data: {
        labels: data.labels,
        datasets: [
          {
            label: `${symbol} Close`,
            data: data.values,
            borderColor: "rgba(59,130,246,0.9)",
            backgroundColor: "rgba(59,130,246,0.25)",
            tension: 0.25,
            spanGaps: true,
            pointRadius: 0,
          },
        ],
      },
      options: {
        scales: {
          x: { title: { display: true, text: "Date" } },
          y: { title: { display: true, text: "Price (USD)" }, beginAtZero: false },
        },
        plugins: { legend: { display: true } },
      },
    });
    ref.current._chart = chart;
    return () => chart.destroy();
  }, [data, symbol]);

  if (!data) return null;
  return h("div", { className: "mt-6 bg-white rounded shadow p-4" }, h("canvas", { ref }));
}

// ---------- MAIN APP ----------
function App() {
  const [input, setInput] = useState("AAPL,MSFT,GOOGL,AMZN,TSLA");
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const [sortKey, setSortKey] = useState(null);  // 'symbol' | 'price' | 'changePercent'
  const [sortDir, setSortDir] = useState("asc");

  const [sel, setSel] = useState(null);
  const [chartData, setChartData] = useState(null);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartErr, setChartErr] = useState("");

  useEffect(() => { doFetch(); }, []);

  function parseSymbols() {
    return input.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  }

  async function doFetch() {
    const symbols = parseSymbols();
    if (!symbols.length) { setRows([]); return; }
    try {
      setLoading(true);
      setErr("");
      const data = await fetchQuotes(symbols);
      setRows(data);
    } catch (e) {
      setErr(e?.message || "Failed to fetch quotes");
    } finally {
      setLoading(false);
    }
  }

  function onSort(key) {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  }

  const sorted = useMemo(() => {
    const arr = [...rows];
    if (!sortKey) return arr;
    arr.sort((a, b) => {
      const A = a[sortKey], B = b[sortKey];
      if (A < B) return sortDir === "asc" ? -1 : 1;
      if (A > B) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
    return arr;
  }, [rows, sortKey, sortDir]);

  async function toggleChart(symbol) {
    if (sel === symbol) {
      setSel(null); setChartData(null); setChartErr("");
      return;
    }
    try {
      setSel(symbol);
      setChartLoading(true);
      setChartErr("");
      const data = await fetchChartData(symbol);
      setChartData(data);
    } catch (e) {
      setChartErr(e?.message || "Failed to fetch chart");
    } finally {
      setChartLoading(false);
    }
  }

  return h(
    "div",
    { className: "bg-white rounded shadow p-6" },
    h("h1", { className: "text-2xl font-semibold mb-4 text-center" }, "Stock Price Dashboard"),

    // Search
    h("div", { className: "flex flex-col sm:flex-row gap-2 mb-4" }, [
      h("input", {
        value: input,
        onChange: (e) => setInput(e.target.value),
        placeholder: "Enter comma-separated tickers (e.g., AAPL,MSFT)",
        className: "flex-1 border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring focus:ring-blue-200",
      }),
      h("button", {
        onClick: doFetch,
        className: "bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded"
      }, "Search"),
    ]),

    // Error
    err && h("div", { className: "bg-red-100 text-red-700 p-3 rounded mb-4" }, err),

    // Table
    h("div", { className: "overflow-x-auto" },
      h("table", { className: "min-w-full divide-y divide-gray-200" }, [
        h("thead", { className: "bg-gray-100" },
          h("tr", null, [
            h("th", { className: "px-3 py-2 text-left cursor-pointer", onClick: () => onSort("symbol") },
              `Symbol ${sortKey === "symbol" ? (sortDir === "asc" ? "▲" : "▼") : ""}`),
            h("th", { className: "px-3 py-2 text-right cursor-pointer", onClick: () => onSort("price") },
              `Price (USD) ${sortKey === "price" ? (sortDir === "asc" ? "▲" : "▼") : ""}`),
            h("th", { className: "px-3 py-2 text-right cursor-pointer", onClick: () => onSort("changePercent") },
              `Change % ${sortKey === "changePercent" ? (sortDir === "asc" ? "▲" : "▼") : ""}`),
            h("th", { className: "px-3 py-2 text-center" }, "Chart"),
          ])
        ),
        h("tbody", { className: "divide-y divide-gray-200" },
          loading
            ? h("tr", null, h("td", { colSpan: 4, className: "py-4" }, h(Spinner)))
            : (sorted.length === 0
              ? h("tr", null, h("td", { colSpan: 4, className: "py-4 text-center text-gray-500" }, "No data. Enter symbols and search."))
              : sorted.map((s) =>
                  h("tr", { key: s.symbol, className: "hover:bg-gray-50" }, [
                    h("td", { className: "px-3 py-2 font-medium" }, s.symbol),
                    h("td", { className: "px-3 py-2 text-right" }, s.price != null ? s.price.toFixed(2) : "-"),
                    h("td", {
                      className:
                        "px-3 py-2 text-right " +
                        (s.changePercent > 0 ? "text-green-600" : s.changePercent < 0 ? "text-red-600" : "")
                    }, s.changePercent != null ? s.changePercent.toFixed(2) + "%" : "-"),
                    h("td", { className: "px-3 py-2 text-center" },
                      h("button", {
                        className: "text-blue-600 underline",
                        onClick: () => toggleChart(s.symbol)
                      }, sel === s.symbol ? "Hide" : "View"))
                  ])
                )
            )
        )
      ])
    ),

    // Chart area
    sel && h("div", { className: "mt-6" }, [
      h("h2", { className: "text-lg font-semibold mb-2" }, `${sel} Price History`),
      chartErr
        ? h("div", { className: "bg-red-100 text-red-700 p-3 rounded mb-4" }, chartErr)
        : (chartLoading ? h("div", { className: "p-4" }, h(Spinner))
           : h(StockChart, { symbol: sel, data: chartData }))
    ])
  );
}

// ---------- MOUNT ----------
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(h(App));
