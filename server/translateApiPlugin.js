const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_RATE_LIMIT_MAX = 60;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const DEFAULT_MAX_TEXT_CHARS = 1200;

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeLang(value, fallback = "en") {
  const safe = String(value ?? "").trim().toLowerCase();
  if (!safe) return fallback;
  const [base] = safe.split("-");
  if (!/^[a-z]{2,3}$/.test(base)) return fallback;
  return base;
}

function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function json(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf-8");
      resolve(text);
    });
    req.on("error", reject);
  });
}

function getClientIp(req) {
  const xff = req.headers?.["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress ?? "unknown";
}

function createRateLimiter({ maxRequests, windowMs }) {
  const buckets = new Map();
  return {
    consume(key) {
      const now = Date.now();
      const current = buckets.get(key);

      if (!current || now >= current.resetAt) {
        const next = {
          count: 1,
          resetAt: now + windowMs,
        };
        buckets.set(key, next);
        return { allowed: true, remaining: Math.max(0, maxRequests - 1), resetAt: next.resetAt };
      }

      if (current.count >= maxRequests) {
        return { allowed: false, remaining: 0, resetAt: current.resetAt };
      }

      current.count += 1;
      return {
        allowed: true,
        remaining: Math.max(0, maxRequests - current.count),
        resetAt: current.resetAt,
      };
    },
  };
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(new Error("Translation request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timeoutId);
    },
  };
}

async function translateWithGoogle({ text, source, target, apiKey, timeoutMs }) {
  const endpoint = `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(apiKey)}`;
  const requestBody = {
    q: text,
    target,
    source,
    format: "text",
  };
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
      signal: timeout.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        `Google Translate request failed (${response.status})`;
      throw new Error(message);
    }

    const translated = payload?.data?.translations?.[0]?.translatedText;
    return decodeEntities(translated || text);
  } finally {
    timeout.done();
  }
}

async function translateWithAzure({
  text,
  source,
  target,
  apiKey,
  region,
  endpoint,
  timeoutMs,
}) {
  const baseUrl = String(endpoint || "https://api.cognitive.microsofttranslator.com").replace(/\/+$/, "");
  const url = `${baseUrl}/translate?api-version=3.0&from=${encodeURIComponent(source)}&to=${encodeURIComponent(target)}`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Ocp-Apim-Subscription-Key": apiKey,
  };
  if (region) headers["Ocp-Apim-Subscription-Region"] = region;

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify([{ text }]),
      signal: timeout.signal,
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message =
        payload?.error?.message ||
        payload?.message ||
        `Azure Translator request failed (${response.status})`;
      throw new Error(message);
    }

    const translated = payload?.[0]?.translations?.[0]?.text;
    return String(translated || text);
  } finally {
    timeout.done();
  }
}

export function createTranslateMiddleware(env = {}) {
  const requestedProvider = String(env.TRANSLATE_PROVIDER ?? "").trim().toLowerCase();
  const googleApiKey = String(env.GOOGLE_TRANSLATE_API_KEY ?? "").trim();
  const azureApiKey = String(env.AZURE_TRANSLATOR_API_KEY ?? "").trim();
  const azureRegion = String(env.AZURE_TRANSLATOR_REGION ?? "").trim();
  const azureEndpoint = String(env.AZURE_TRANSLATOR_ENDPOINT ?? "").trim();

  const provider =
    requestedProvider ||
    (googleApiKey ? "google" : "") ||
    (azureApiKey ? "azure" : "") ||
    "none";

  const timeoutMs = toInt(env.TRANSLATE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const maxRequests = toInt(env.TRANSLATE_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX);
  const windowMs = toInt(env.TRANSLATE_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS);
  const maxTextChars = toInt(env.TRANSLATE_MAX_TEXT_CHARS, DEFAULT_MAX_TEXT_CHARS);
  const limiter = createRateLimiter({ maxRequests, windowMs });

  return async (req, res, next) => {
    if (!req.url?.startsWith("/api/translate")) {
      if (typeof next === "function") {
        return next();
      }
      return json(res, 404, { error: "Translate endpoint not found" });
    }

    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    const ip = getClientIp(req);
    const quota = limiter.consume(ip);
    res.setHeader("X-RateLimit-Limit", String(maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(quota.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.floor(quota.resetAt / 1000)));
    if (!quota.allowed) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((quota.resetAt - Date.now()) / 1000))));
      return json(res, 429, { error: "Rate limit exceeded" });
    }

    if (provider === "none") {
      return json(res, 503, {
        error: "Translation provider is not configured",
        hint: "Set TRANSLATE_PROVIDER and provider API keys in .env",
      });
    }

    const requestUrl = new URL(req.url, "http://localhost");
    let text = String(requestUrl.searchParams.get("text") ?? "");
    let source = normalizeLang(requestUrl.searchParams.get("source"), "en");
    let target = normalizeLang(requestUrl.searchParams.get("lang"), "en");

    if (!text && req.method === "POST") {
      try {
        const raw = await readRequestBody(req);
        if (raw.trim()) {
          const payload = JSON.parse(raw);
          text = String(payload?.text ?? "");
          source = normalizeLang(payload?.source, source);
          target = normalizeLang(payload?.lang, target);
        }
      } catch (error) {
        return json(res, 400, { error: "Invalid JSON body" });
      }
    }

    text = text.trim();
    if (!text) {
      return json(res, 400, { error: "Missing required query parameter: text" });
    }
    if (text.length > maxTextChars) {
      return json(res, 400, {
        error: `Text exceeds max length (${maxTextChars} chars)`,
      });
    }
    if (!target) {
      return json(res, 400, { error: "Missing required query parameter: lang" });
    }

    if (source === target) {
      return json(res, 200, {
        provider: "identity",
        source,
        target,
        translatedText: text,
      });
    }

    try {
      let translatedText = text;

      if (provider === "google") {
        if (!googleApiKey) {
          return json(res, 503, { error: "GOOGLE_TRANSLATE_API_KEY is not set" });
        }
        translatedText = await translateWithGoogle({
          text,
          source,
          target,
          apiKey: googleApiKey,
          timeoutMs,
        });
      } else if (provider === "azure") {
        if (!azureApiKey) {
          return json(res, 503, { error: "AZURE_TRANSLATOR_API_KEY is not set" });
        }
        translatedText = await translateWithAzure({
          text,
          source,
          target,
          apiKey: azureApiKey,
          region: azureRegion,
          endpoint: azureEndpoint,
          timeoutMs,
        });
      } else {
        return json(res, 503, {
          error: `Unsupported TRANSLATE_PROVIDER "${provider}"`,
        });
      }

      return json(res, 200, {
        provider,
        source,
        target,
        translatedText,
      });
    } catch (error) {
      return json(res, 502, {
        error: "Translation upstream request failed",
        detail: String(error?.message ?? error),
      });
    }
  };
}

export function translateApiPlugin(env = {}) {
  const middleware = createTranslateMiddleware(env);
  return {
    name: "aac-translate-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
