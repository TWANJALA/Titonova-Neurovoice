import { createStripeBillingMiddleware } from "../../server/stripeBillingApiPlugin";

export const config = {
  api: {
    bodyParser: false,
  },
};

const billingMiddleware = createStripeBillingMiddleware(process.env);

function normalizeBillingUrl(req) {
  const rawPath = req.query?.path;
  const segments = Array.isArray(rawPath)
    ? rawPath
    : rawPath
      ? [String(rawPath)]
      : [];
  const suffix = segments.length > 0 ? `/${segments.map((part) => encodeURIComponent(part)).join("/")}` : "";
  const queryIndex = String(req.url ?? "").indexOf("?");
  const query = queryIndex >= 0 ? String(req.url).slice(queryIndex) : "";
  return `/api/billing${suffix}${query}`;
}

export default async function handler(req, res) {
  req.url = normalizeBillingUrl(req);
  return billingMiddleware(req, res, () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Billing endpoint not found" }));
  });
}
