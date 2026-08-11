// api/scorecard.js
const FRED_BASE = "https://api.stlouisfed.org/fred/series/observations";
const COT_URL = "https://futuresbench.com/api/v1/latest.json";

const SERIES = {
  gdp: "A191RL1Q225SBEA",
  sentiment: "UMCSENT",
  cpi: "CPIAUCSL",
  ppi: "PPIFIS",
  pce: "PCEPI",
  retail: "RSXFS",
  dgs2: "DGS2",
  payems: "PAYEMS",
  unrate: "UNRATE",
  claims: "ICSA",
  jolts: "JTSJOL",
};

const COT_SLUG = {
  XAUUSD: "gold",
  XAGUSD: "silver",
  USOIL: "wti_crude_oil",
  DXY: "us_dollar_index",
};

const LIVE_ASSETS = ["XAUUSD", "XAGUSD", "USOIL", "DXY"];

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

function directionSignal(latest, prior, polarity) {
  if (latest === undefined || latest === null || prior === undefined || prior === null) return "Neutral";
  const diff = latest - prior;
  if (Math.abs(diff) < 1e-9) return "Neutral";
  const wentUp = diff > 0;
  const bullish = polarity === 1 ? wentUp : !wentUp;
  return bullish ? "Bullish" : "Bearish";
}

// Year-over-year % change for a monthly index series (CPI, PPI, PCE all work the same way)
function yoyChange(obs, offset = 0) {
  const yearAgoIdx = offset + 12;
  if (obs.length <= yearAgoIdx) return null;
  const latest = obs[offset].value;
  const yearAgo = obs[yearAgoIdx].value;
  return ((latest - yearAgo) / yearAgo) * 100;
}

// Month-over-month % change
function momChange(obs, offset = 0) {
  if (obs.length <= offset + 1) return null;
  const latest = obs[offset].value;
  const prior = obs[offset + 1].value;
  return ((latest - prior) / prior) * 100;
}

// Builds a "change" string (like a Surprise column) from two already-formatted percent numbers
function pctChangeStr(current, previous) {
  if (current === null || previous === null) return "—";
  const diff = current - previous;
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff.toFixed(1)}pts`;
}

async function buildEconomicCategories(apiKey, polarity) {
  const ids = [SERIES.gdp, SERIES.sentiment, SERIES.cpi, SERIES.ppi, SERIES.pce, SERIES.retail, SERIES.dgs2, SERIES.payems, SERIES.unrate, SERIES.claims, SERIES.jolts];
  const [gdp, sentiment, cpi, ppi, pce, retail, dgs2, payems, unrate, claims, jolts] = await Promise.all(
    ids.map((id) => fredSeries(id, apiKey))
  );

  const cpiNow = yoyChange(cpi, 0);
  const cpiPrev = yoyChange(cpi, 1);
  const ppiNow = yoyChange(ppi, 0);
  const ppiPrev = yoyChange(ppi, 1);
  const pceNow = yoyChange(pce, 0);
  const pcePrev = yoyChange(pce, 1);
  const retailNow = momChange(retail, 0);
  const retailPrev = momChange(retail, 1);
  const payemsDiff = payems.length >= 2 ? payems[0].value - payems[1].value : null;
  const payemsPrevDiff = payems.length >= 3 ? payems[1].value - payems[2].value : null;

  return {
    "Economic Growth": [
      {
        name: "GDP Growth (QoQ annualized)",
        signal: directionSignal(gdp[0]?.value, gdp[1]?.value, polarity),
        previous: gdp[1] ? `${gdp[1].value}%` : "—",
        current: gdp[0] ? `${gdp[0].value}%` : "—",
        change: gdp[0] && gdp[1] ? pctChangeStr(gdp[0].value, gdp[1].value) : "—",
      },
      {
        name: "Consumer Sentiment (U. Michigan)",
        signal: directionSignal(sentiment[0]?.value, sentiment[1]?.value, polarity),
        previous: sentiment[1] ? `${sentiment[1].value}` : "—",
        current: sentiment[0] ? `${sentiment[0].value}` : "—",
        change: sentiment[0] && sentiment[1] ? pctChangeStr(sentiment[0].value, sentiment[1].value) : "—",
      },
      {
        name: "Retail Sales MoM",
        signal: directionSignal(retailNow, retailPrev, polarity),
        previous: retailPrev !== null ? `${retailPrev.toFixed(1)}%` : "—",
        current: retailNow !== null ? `${retailNow.toFixed(1)}%` : "—",
        change: pctChangeStr(retailNow, retailPrev),
      },
    ],
    Inflation: [
      {
        name: "CPI YoY",
        signal: directionSignal(cpiNow, cpiPrev, -polarity),
        previous: cpiPrev !== null ? `${cpiPrev.toFixed(1)}%` : "—",
        current: cpiNow !== null ? `${cpiNow.toFixed(1)}%` : "—",
        change: pctChangeStr(cpiNow, cpiPrev),
      },
      {
        name: "PPI YoY",
        signal: directionSignal(ppiNow, ppiPrev, -polarity),
        previous: ppiPrev !== null ? `${ppiPrev.toFixed(1)}%` : "—",
        current: ppiNow !== null ? `${ppiNow.toFixed(1)}%` : "—",
        change: pctChangeStr(ppiNow, ppiPrev),
      },
      {
        name: "PCE YoY",
        signal: directionSignal(pceNow, pcePrev, -polarity),
        previous: pcePrev !== null ? `${pcePrev.toFixed(1)}%` : "—",
        current: pceNow !== null ? `${pceNow.toFixed(1)}%` : "—",
        change: pctChangeStr(pceNow, pcePrev),
      },
      {
        name: "2Yr Treasury Yield",
        signal: directionSignal(dgs2[0]?.value, dgs2[1]?.value, polarity),
        previous: dgs2[1] ? `${dgs2[1].value}%` : "—",
        current: dgs2[0] ? `${dgs2[0].value}%` : "—",
        change: dgs2[0] && dgs2[1] ? pctChangeStr(dgs2[0].value, dgs2[1].value) : "—",
      },
    ],
    "Jobs Market": [
      {
        name: "Non-Farm Payroll (MoM change)",
        signal: directionSignal(payemsDiff, payemsPrevDiff, polarity),
        previous: payemsPrevDiff !== null ? `${payemsPrevDiff.toFixed(0)}k` : "—",
        current: payemsDiff !== null ? `${payemsDiff.toFixed(0)}k` : "—",
        change: "—",
      },
      {
        name: "Unemployment Rate",
        signal: directionSignal(unrate[0]?.value, unrate[1]?.value, -polarity),
        previous: unrate[1] ? `${unrate[1].value}%` : "—",
        current: unrate[0] ? `${unrate[0].value}%` : "—",
        change: unrate[0] && unrate[1] ? pctChangeStr(unrate[0].value, unrate[1].value) : "—",
      },
      {
        name: "Weekly Jobless Claims",
        signal: directionSignal(claims[0]?.value, claims[1]?.value, -polarity),
        previous: claims[1] ? `${claims[1].value}` : "—",
        current: claims[0] ? `${claims[0].value}` : "—",
        change: "—",
      },
      {
        name: "JOLTS Job Openings",
        signal: directionSignal(jolts[0]?.value, jolts[1]?.value, polarity),
        previous: jolts[1] ? `${(jolts[1].value / 1000).toFixed(2)}M` : "—",
        current: jolts[0] ? `${(jolts[0].value / 1000).toFixed(2)}M` : "—",
        change: "—",
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

    // Long/short percentages, if the feed provides them
    const longPct = market.long_pct ?? market.pct_long ?? null;
    const shortPct = market.short_pct ?? market.pct_short ?? null;

    // Weekly change in positioning, if the feed provides a prior-week figure
    const priorNet = market.net_noncommercial_prior ?? market.prior_net ?? null;
    const weeklyChange = priorNet !== null ? net - priorNet : null;
    let changeSignal = "Neutral";
    if (weeklyChange !== null && weeklyChange !== 0) {
      const wentUp = weeklyChange > 0;
      changeSignal = polarity === 1 ? (wentUp ? "Bullish" : "Bearish") : (wentUp ? "Bearish" : "Bullish");
    }

    const items = [
      {
        name: "COT — Net Positioning (Managed Money)",
        signal,
        previous: priorNet !== null ? `${priorNet}` : "—",
        current: `${net}`,
        change: weeklyChange !== null ? `${weeklyChange > 0 ? "+" : ""}${weeklyChange}` : "—",
      },
    ];

    if (longPct !== null && shortPct !== null) {
      items.push({
        name: "COT — Long % / Short %",
        signal: "Neutral",
        previous: "—",
        current: `${longPct}% / ${shortPct}%`,
        change: "—",
      });
    }

    items.push({
      name: "COT — Latest Buys/Sells (weekly change)",
      signal: weeklyChange !== null ? changeSignal : "Neutral",
      previous: "—",
      current: weeklyChange !== null ? `${weeklyChange > 0 ? "+" : ""}${weeklyChange}` : "no data",
      change: "—",
    });

    return { "Institutional Activity": items };
  } catch (e) {
    return {
      "Institutional Activity": [
        { name: "COT — Net Positioning", signal: "Neutral", previous: "—", current: "no data", change: "—" },
      ],
    };
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(200).end();
    return;
  }

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
