// Serverless function: GET /api/stats
// Proxies indexer stats when INDEXER_STATS_URL is set; otherwise returns graceful fallback.

const FALLBACK = {
  network: "testnet",
  totalAgents: null,
  totalJobs: null,
  activeJobs: null,
  feeRevenue: null,
  feeRevenueFormatted: "Stats temporarily unavailable",
  status: "fallback",
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.status(405).json({ error: "Method Not Allowed" });
    return;
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
  res.setHeader("Content-Type", "application/json");

  const indexerUrl = process.env.INDEXER_STATS_URL || process.env.INDEXER_URL;
  if (indexerUrl) {
    try {
      const base = indexerUrl.replace(/\/$/, "");
      const upstream = await fetch(`${base}/stats`, { signal: AbortSignal.timeout(5000) });
      if (upstream.ok) {
        const data = await upstream.json();
        res.status(200).json({
          ...data,
          status: "ok",
          timestamp: new Date().toISOString(),
        });
        return;
      }
    } catch {
      // fall through
    }
  }

  res.status(200).json({
    ...FALLBACK,
    timestamp: new Date().toISOString(),
  });
}