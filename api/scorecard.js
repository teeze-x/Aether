// api/scorecard.js
// Serverless function (deploy on Vercel) that builds a macro scorecard
// using real FRED economic data + real CFTC COT data (via FuturesBench's
// free feed). Assets not yet covered by a free data source return
// live: false so the frontend knows to keep showing demo data for them.

const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const COT_URL = "https://futuresbench.com/api/v1/latest.json";

// FRED series used to build the Economic Growth / Inflation / Jobs categories
const SERIES = {
  gdp: "A191RL1Q225SBEA",  // Real GDP growth, QoQ annualized %
  sentiment: "UMCSENT",    // U. Michigan consumer sentiment index
  cpi: "CPIAUCSL",         // CPI index (monthly) -> we compute YoY % ourselves
  dgs2: "DGS2",            // 2-year Treasury yield
  payems: "PAYEMS",        // Nonfarm payrolls level (thousands) -> MoM change
  unrate: "UNRATE",        // Unemployment rate %
  claims: "ICSA",          // Initial jobless claims, weekly
};

// Which COT market slug (on FuturesBench) matches which asset
const COT_SLUG = {
  XAUUSD: "gold",
  XAGUSD: "silver",
  USOIL: "wti_crude_oil",
  DXY: "us_dollar_index",
};

// Assets with a full live build right now. Everything else stays demo.
const LIVE_ASSETS = ["XAUUSD", "XAGUSD", "USOIL", "DXY"];

// Polarity: does "stronger" US macro data help or hurt this asset?
// +1 = behaves like the US dollar (strong data -> bullish)
// -1 = behaves like a safe haven / inverse-dollar asset (strong data -> bearish)
const POLARITY = {
  XAUUSD: -1,
  XAGUSD: -1,
  USOIL: 1,
  DXY: 1,
};

async function fredSeries(seriesId, apiKey) {
  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=14`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`FRED error for ${seriesId}: ${res.status}`);
  const json = await res.json();
  return (json.observations || [])
    .filter((o) => o.value !== ".")
    .map((o) => ({ date: o.date, value: parseFloat(o.value) }));
}

// diff > 0 means the number went up since the prior reading.
// polarity tells us whether "up" is good or bad for this asset.
function directionSignal(latest, prior, polarity) {
  if (latest === undefined || latest === null || prior === undefined || prior === null) return "Neutral";
  const diff = latest - prior;
  if (Math.abs(diff) < 1e-9) return "Neutral";
  const wentUp = diff > 0;
  const bullish = polarity === 1 ? wentUp : !wentUp;
  return bullish ? "Bullish" : "Bearish";
}

function cpiYoY(obs, offset = 0) {
  const latestIdx = offset;
  const yearAgoIdx = offset + 12;
  if (obs.length <= yearAgoIdx) return null;
  const latest = obs[latestIdx].value;
  const yearAgo = obs[yearAgoIdx].value;
  return ((latest - yearAgo) / yearAgo) * 100;
}

async function buildEconomicCategories(apiKey, polarity) {
  const [gdp, sentiment, cpi, dgs2, payems, unrate, claims] = await Promise.all(
    [SERIES.gdp, SERIES.sentiment, SERIES.cpi, SERIES.dgs2, SERIES.payems, SERIES.unrate, SERIES.claims].map((id) =>
      fredSeries(id, apiKey)
    )
  );

  const cpiNow = cpiYoY(cpi, 0);
  const cpiPrev = cpiYoY(cpi, 1);

  const payemsDiff = payems.length >= 2 ? payems[0].value - payems[1].value : null;
  const payemsPrevDiff = payems.length >= 3 ? payems[1].value - payems[2].value : null;

  return {
    "Economic Growth": [
      {
        name: "GDP Growth (QoQ annualized)",
        signal: directionSignal(gdp[0]?.value, gdp[1]?.value, polarity),
        detail: gdp[0] ? `${gdp[0].value}% latest (${gdp[0].date})` : "no data",
      },
      {
        name: "Consumer Sentiment (U. Michigan)",
        signal: directionSignal(sentiment[0]?.value, sentiment[1]?.value, polarity),
        detail: sentiment[0] ? `${sentiment[0].value} index` : "no data",
      },
    ],
    Inflation: [
      {
        name: "CPI YoY",
        signal: directionSignal(cpiNow, cpiPrev, -polarity),
        detail: cpiNow !== null ? `${cpiNow.toFixed(1)}% YoY` : "no data",
      },
      {
        name: "2Yr Treasury Yield",
        signal: directionSignal(dgs2[0]?.value, dgs2[1]?.value, polarity),
        detail: dgs2[0] ? `${dgs2[0].value}%` : "no data",
      },
    ],
    "Jobs Market": [
      {
        name: "Non-Farm Payroll (MoM change)",
        signal: directionSignal(payemsDiff, payemsPrevDiff, polarity),
        detail: payemsDiff !== null ? `${payemsDiff.toFixed(0)}k jobs added` : "no data",
      },
      {
        name: "Unemployment Rate",
        signal: directionSignal(unrate[0]?.value, unrate[1]?.value, -polarity),
        detail: unrate[0] ? `${unrate[0].value}%` : "no data",
      },
      {
        name: "Weekly Jobless Claims",
        signal: directionSignal(claims[0]?.value, claims[1]?.value, -polarity),
        detail: claims[0] ? `${claims[0].value} claims` : "no data",
      },
    ],
  };
}

async function buildCOTCategory(slug, polarity) {
  try {
    const res = await fetch(COT_URL);
    if (!res.ok) throw new Error(`COT feed error: ${res.status}`);
    const json = await res.json();
    const market = json.markets?.[slug];
    if (!market) throw new Error("slug not found in COT feed");

    const net = market.net_noncommercial ?? market.net_nonco ?? market.net ?? 0;
    let signal = net === 0 ? "Neutral" : net > 0 ? "Bullish" : "Bearish";
    if (polarity !== 1 && signal !== "Neutral") {
      signal = signal === "Bullish" ? "Bearish" : "Bullish";
    }

    return {
      "Institutional Activity": [
        {
          name: "COT — Net Positioning (Managed Money)",
          signal,
          detail: `Net position: ${net}`,
        },
      ],
    };
  } catch (e) {
    return {
      "Institutional Activity": [
        { name: "COT — Net Positioning", signal: "Neutral", detail: "data unavailable right now" },
      ],
    };
  }
}

export default async function handler(req, res) {
  const { asset } = req.query;
  const apiKey = process.env.FRED_API_KEY;

  if (!asset || !LIVE_ASSETS.includes(asset)) {
    res.status(200).json({ live: false, reason: "This asset isn't wired to live data yet." });
    return;
  }
  if (!apiKey) {
    res.status(500).json({ live: false, reason: "Missing FRED_API_KEY environment variable on the server." });
    return;
  }

  try {
    const polarity = POLARITY[asset];
    const [econCats, cotCat] = await Promise.all([
      buildEconomicCategories(apiKey, polarity),
      buildCOTCategory(COT_SLUG[asset], polarity),
    ]);

    res.status(200).json({
      live: true,
      asset,
      updated: new Date().toISOString(),
      categories: { ...cotCat, ...econCats },
    });
  } catch (e) {
    res.status(500).json({ live: false, reason: e.message || "unknown error" });
  }
}
