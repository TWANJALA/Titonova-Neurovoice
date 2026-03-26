import { createStripeBillingMiddleware } from "../../server/stripeBillingApiPlugin.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

const billingMiddleware = createStripeBillingMiddleware(process.env);

function normalizeBillingUrl(req) {
  const originalUrl = String(req.url ?? "");
  const originalPathname = originalUrl.split("?")[0] ?? "";
  if (
    originalPathname.startsWith("/api/billing/") &&
    !originalPathname.includes("[...path]")
  ) {
    return originalUrl;
  }

  const rawPath = req.query?.path;
  const segments = Array.isArray(rawPath)
    ? rawPath
    : rawPath
      ? [String(rawPath)]
      : [];
  const suffix = segments.length > 0 ? `/${segments.map((part) => encodeURIComponent(part)).join("/")}` : "";

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query ?? {})) {
    if (key === "path") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, String(item));
      }
      continue;
    }
    if (value !== undefined && value !== null) {
      params.append(key, String(value));
    }
  }

  const query = params.toString();
  return `/api/billing${suffix}${query ? `?${query}` : ""}`;
}

export default async function handler(req, res) {
  req.url = normalizeBillingUrl(req);
  return billingMiddleware(req, res, () => {
    res.statusCode = 404;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "Billing endpoint not found" }));
  });
}
