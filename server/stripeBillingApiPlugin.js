import { createHmac, timingSafeEqual } from "node:crypto";
import {
  getBillingRecord,
  getUidForStripeCustomerAsync,
  persistBillingRecord,
} from "./firebaseBillingStore";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_AUTH_TIMEOUT_MS = 10000;
const DEFAULT_RATE_LIMIT_MAX = 30;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;
const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

const KNOWN_TIERS = new Set(["basic", "pro", "premium"]);

function toInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeTier(value, fallback = "basic") {
  const normalized = String(value ?? "").trim().toLowerCase();
  return KNOWN_TIERS.has(normalized) ? normalized : fallback;
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
  const timeoutId = setTimeout(() => controller.abort(new Error("Stripe request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timeoutId);
    },
  };
}

function toAbsoluteUrl(value, baseUrl) {
  const raw = String(value ?? "").trim();
  if (!raw) return baseUrl;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) return `${baseUrl}${raw}`;
  return `${baseUrl}/${raw}`;
}

function getBaseAppUrl(req, env = {}) {
  const configured = String(env.BILLING_APP_BASE_URL ?? "").trim();
  if (configured) return configured.replace(/\/+$/, "");

  const host = String(req.headers?.host ?? "localhost:5173").trim();
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] ?? "").trim().toLowerCase();
  const proto = forwardedProto === "https" ? "https" : "http";
  return `${proto}://${host}`;
}

function extractBearerToken(headerValue) {
  const raw = String(headerValue ?? "").trim();
  if (!raw) return "";
  const match = raw.match(/^Bearer\s+(.+)$/i);
  return match ? String(match[1] ?? "").trim() : "";
}

async function verifyFirebaseIdToken({ idToken, apiKey, timeoutMs }) {
  const safeApiKey = String(apiKey ?? "").trim();
  if (!safeApiKey) {
    throw new Error("Firebase Web API key is not configured.");
  }

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(safeApiKey)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ idToken }),
        signal: timeout.signal,
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = String(
        payload?.error?.message ?? payload?.error_description ?? payload?.error ?? response.statusText ?? "unknown"
      ).trim();
      throw new Error(`Firebase token verification failed: ${detail}`);
    }

    const userRecord = Array.isArray(payload?.users) ? payload.users[0] ?? null : null;
    const uid = String(userRecord?.localId ?? "").trim();
    if (!uid) {
      throw new Error("Firebase token response did not include localId.");
    }

    return {
      uid,
      email: String(userRecord?.email ?? "").trim(),
    };
  } finally {
    timeout.done();
  }
}

async function requireAuthenticatedUser({ req, res, apiKey, timeoutMs }) {
  const token = extractBearerToken(req.headers?.authorization);
  if (!token) {
    json(res, 401, { error: "Missing Authorization bearer token" });
    return null;
  }

  try {
    return await verifyFirebaseIdToken({
      idToken: token,
      apiKey,
      timeoutMs,
    });
  } catch (error) {
    json(res, 401, {
      error: "Authentication failed",
      detail: String(error?.message ?? error),
    });
    return null;
  }
}

async function stripeRequest({ method, path, secretKey, timeoutMs, formData }) {
  const url = `https://api.stripe.com${path}`;
  const headers = {
    Authorization: `Bearer ${secretKey}`,
    Accept: "application/json",
  };
  const options = {
    method,
    headers,
  };

  if (formData) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    options.body = formData.toString();
  }

  const timeout = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: timeout.signal });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage =
        payload?.error?.message ||
        payload?.message ||
        `Stripe API request failed (${response.status})`;
      throw new Error(errorMessage);
    }
    return payload;
  } finally {
    timeout.done();
  }
}

function parseStripeSignatureHeader(headerValue) {
  const raw = String(headerValue ?? "").trim();
  if (!raw) return { timestamp: 0, signatures: [] };

  const parts = raw.split(",").map((entry) => entry.trim()).filter(Boolean);
  let timestamp = 0;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=");
    if (!key || !value) continue;
    if (key === "t") {
      timestamp = Number.parseInt(value, 10) || 0;
    }
    if (key === "v1") {
      signatures.push(value.trim());
    }
  }

  return { timestamp, signatures };
}

function secureCompareHex(expectedHex, candidateHex) {
  const expected = Buffer.from(String(expectedHex ?? ""), "hex");
  const candidate = Buffer.from(String(candidateHex ?? ""), "hex");
  if (expected.length === 0 || candidate.length === 0 || expected.length !== candidate.length) {
    return false;
  }
  return timingSafeEqual(expected, candidate);
}

function verifyStripeWebhookSignature({ rawBody, signatureHeader, webhookSecret, toleranceSeconds }) {
  const { timestamp, signatures } = parseStripeSignatureHeader(signatureHeader);
  if (!timestamp || signatures.length === 0) {
    throw new Error("Missing Stripe signature values.");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    throw new Error("Stripe signature timestamp is outside the tolerance window.");
  }

  const signedPayload = `${timestamp}.${rawBody}`;
  const expectedSignature = createHmac("sha256", webhookSecret).update(signedPayload, "utf8").digest("hex");
  const hasMatch = signatures.some((candidate) => secureCompareHex(expectedSignature, candidate));
  if (!hasMatch) {
    throw new Error("Stripe signature verification failed.");
  }
}

function getTierFromPriceId(priceId, priceIdToTier) {
  const safePriceId = String(priceId ?? "").trim();
  if (!safePriceId) return "";
  return priceIdToTier.get(safePriceId) ?? "";
}

async function resolveUidForStripeObject(stripeObject, customerId, env) {
  const metadataUid = String(stripeObject?.metadata?.user_uid ?? "").trim();
  if (metadataUid) return metadataUid;

  const fallbackUid = await getUidForStripeCustomerAsync({ env, customerId });
  if (fallbackUid) return fallbackUid;

  return "";
}

function normalizeSubscriptionStatus(eventType, stripeStatus) {
  if (eventType === "customer.subscription.deleted") return "canceled";

  const normalized = String(stripeStatus ?? "").trim().toLowerCase();
  if (!normalized) return "inactive";
  if (normalized === "trialing") return "active";
  return normalized;
}

async function processStripeWebhookEvent({ event, env, priceIdToTier }) {
  const eventType = String(event?.type ?? "").trim();
  const stripeObject = event?.data?.object ?? {};
  const eventId = String(event?.id ?? "").trim();

  if (eventType === "checkout.session.completed") {
    const mode = String(stripeObject?.mode ?? "").trim().toLowerCase();
    if (mode !== "subscription") {
      return { handled: true, detail: "Ignored non-subscription checkout session." };
    }

    const uid = String(stripeObject?.metadata?.user_uid ?? stripeObject?.client_reference_id ?? "").trim();
    if (!uid) {
      return { handled: false, detail: "Checkout session is missing user UID metadata." };
    }

    const tier = normalizeTier(stripeObject?.metadata?.plan_tier, "basic");
    const customerId = String(stripeObject?.customer ?? "").trim();
    const subscriptionId = String(stripeObject?.subscription ?? "").trim();
    const sessionId = String(stripeObject?.id ?? "").trim();

    const persisted = await persistBillingRecord({
      env,
      uid,
      billing: {
        tier,
        status: "active",
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscriptionId,
        lastCheckoutSessionId: sessionId,
        lastStripeEventId: eventId,
        updatedAt: new Date().toISOString(),
      },
    });

    return {
      handled: true,
      detail: `Checkout activation persisted (${persisted.mode}).`,
      uid,
      tier,
      status: "active",
    };
  }

  if (eventType === "customer.subscription.created" || eventType === "customer.subscription.updated" || eventType === "customer.subscription.deleted") {
    const customerId = String(stripeObject?.customer ?? "").trim();
    const uid = await resolveUidForStripeObject(stripeObject, customerId, env);
    if (!uid) {
      return { handled: false, detail: "Subscription event missing user UID metadata/customer mapping." };
    }

    const stripeStatus = String(stripeObject?.status ?? "").trim().toLowerCase();
    const status = normalizeSubscriptionStatus(eventType, stripeStatus);
    const metadataTier = normalizeTier(stripeObject?.metadata?.plan_tier, "");
    const firstPriceId = String(stripeObject?.items?.data?.[0]?.price?.id ?? "").trim();
    const tier = normalizeTier(metadataTier || getTierFromPriceId(firstPriceId, priceIdToTier), "basic");
    const subscriptionId = String(stripeObject?.id ?? "").trim();

    const existing = (await getBillingRecord({ env, uid })) ?? {};

    const persisted = await persistBillingRecord({
      env,
      uid,
      billing: {
        tier,
        status,
        stripeCustomerId: customerId || existing?.stripeCustomerId || "",
        stripeSubscriptionId: subscriptionId || existing?.stripeSubscriptionId || "",
        lastCheckoutSessionId: existing?.lastCheckoutSessionId || "",
        lastStripeEventId: eventId,
        updatedAt: new Date().toISOString(),
      },
    });

    return {
      handled: true,
      detail: `Subscription state persisted (${persisted.mode}).`,
      uid,
      tier,
      status,
    };
  }

  if (eventType === "invoice.payment_failed") {
    const customerId = String(stripeObject?.customer ?? "").trim();
    const uid = await resolveUidForStripeObject(stripeObject, customerId, env);
    if (!uid) {
      return { handled: false, detail: "Invoice event missing user UID metadata/customer mapping." };
    }

    const existing = (await getBillingRecord({ env, uid })) ?? {};
    const persisted = await persistBillingRecord({
      env,
      uid,
      billing: {
        tier: normalizeTier(existing?.tier, "basic"),
        status: "past_due",
        stripeCustomerId: customerId || existing?.stripeCustomerId || "",
        stripeSubscriptionId: String(stripeObject?.subscription ?? existing?.stripeSubscriptionId ?? "").trim(),
        lastCheckoutSessionId: existing?.lastCheckoutSessionId || "",
        lastStripeEventId: eventId,
        updatedAt: new Date().toISOString(),
      },
    });

    return {
      handled: true,
      detail: `Payment-failed status persisted (${persisted.mode}).`,
      uid,
      status: "past_due",
    };
  }

  return { handled: true, detail: `Event type "${eventType}" ignored.` };
}

export function stripeBillingApiPlugin(env = {}) {
  const stripeSecretKey = String(env.STRIPE_SECRET_KEY ?? "").trim();
  const stripeWebhookSecret = String(env.STRIPE_WEBHOOK_SECRET ?? "").trim();
  const firebaseWebApiKey = String(env.FIREBASE_WEB_API_KEY ?? env.VITE_FIREBASE_API_KEY ?? "").trim();
  const stripePriceIds = {
    basic: String(env.STRIPE_PRICE_BASIC_MONTHLY ?? "").trim(),
    pro: String(env.STRIPE_PRICE_PRO_MONTHLY ?? "").trim(),
    premium: String(env.STRIPE_PRICE_PREMIUM_MONTHLY ?? "").trim(),
  };
  const priceIdToTier = new Map(
    Object.entries(stripePriceIds)
      .filter(([, priceId]) => Boolean(priceId))
      .map(([tier, priceId]) => [priceId, tier])
  );

  const timeoutMs = toInt(env.BILLING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const authTimeoutMs = toInt(env.BILLING_AUTH_TIMEOUT_MS, DEFAULT_AUTH_TIMEOUT_MS);
  const maxRequests = toInt(env.BILLING_RATE_LIMIT_MAX, DEFAULT_RATE_LIMIT_MAX);
  const windowMs = toInt(env.BILLING_RATE_LIMIT_WINDOW_MS, DEFAULT_RATE_LIMIT_WINDOW_MS);
  const limiter = createRateLimiter({ maxRequests, windowMs });

  const middleware = async (req, res, next) => {
    if (!req.url?.startsWith("/api/billing")) {
      return next();
    }

    const requestUrl = new URL(req.url, "http://localhost");

    if (requestUrl.pathname === "/api/billing/webhook") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return json(res, 405, { error: "Method not allowed" });
      }

      if (!stripeWebhookSecret) {
        return json(res, 503, { error: "STRIPE_WEBHOOK_SECRET is not configured" });
      }

      let rawBody = "";
      try {
        rawBody = await readRequestBody(req);
      } catch (error) {
        return json(res, 400, { error: "Failed to read webhook body" });
      }

      try {
        verifyStripeWebhookSignature({
          rawBody,
          signatureHeader: req.headers?.["stripe-signature"],
          webhookSecret: stripeWebhookSecret,
          toleranceSeconds: STRIPE_WEBHOOK_TOLERANCE_SECONDS,
        });
      } catch (error) {
        return json(res, 400, {
          error: "Invalid Stripe webhook signature",
          detail: String(error?.message ?? error),
        });
      }

      let event = null;
      try {
        event = rawBody.trim() ? JSON.parse(rawBody) : null;
      } catch (error) {
        return json(res, 400, { error: "Invalid webhook JSON payload" });
      }

      if (!event || typeof event !== "object") {
        return json(res, 400, { error: "Webhook payload is empty" });
      }

      try {
        const result = await processStripeWebhookEvent({
          event,
          env,
          priceIdToTier,
        });
        return json(res, 200, {
          received: true,
          handled: Boolean(result?.handled),
          detail: String(result?.detail ?? "Webhook processed."),
          uid: String(result?.uid ?? ""),
          tier: String(result?.tier ?? ""),
          status: String(result?.status ?? ""),
        });
      } catch (error) {
        return json(res, 502, {
          error: "Webhook processing failed",
          detail: String(error?.message ?? error),
        });
      }
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

    if (requestUrl.pathname === "/api/billing/health") {
      const supabaseReady = Boolean(
        String(env.SUPABASE_URL ?? "").trim() && String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()
      );
      const firestoreReady = Boolean(
        String(env.FIREBASE_ADMIN_PROJECT_ID ?? "").trim() &&
          String(env.FIREBASE_ADMIN_CLIENT_EMAIL ?? "").trim() &&
          String(env.FIREBASE_ADMIN_PRIVATE_KEY ?? "").trim()
      );
      const plansConfigured = Object.fromEntries(
        Object.entries(stripePriceIds).map(([tier, priceId]) => [tier, Boolean(priceId)])
      );
      const checkoutReady = Boolean(stripeSecretKey) && Object.values(plansConfigured).every(Boolean);
      const billingStoreReady = supabaseReady || firestoreReady;
      const authReady = Boolean(firebaseWebApiKey);
      return json(res, 200, {
        ready: checkoutReady && Boolean(stripeWebhookSecret) && billingStoreReady && authReady,
        checkoutReady,
        webhookReady: Boolean(stripeWebhookSecret),
        authReady,
        billingStore: {
          supabaseReady,
          firestoreReady,
          fallback: "memory",
        },
        plansConfigured,
      });
    }

    if (requestUrl.pathname === "/api/billing/subscription-status") {
      if (req.method !== "GET") {
        res.setHeader("Allow", "GET");
        return json(res, 405, { error: "Method not allowed" });
      }

      const authUser = await requireAuthenticatedUser({
        req,
        res,
        apiKey: firebaseWebApiKey,
        timeoutMs: authTimeoutMs,
      });
      if (!authUser) {
        return;
      }

      const requestedUid = String(requestUrl.searchParams.get("uid") ?? "").trim();
      if (requestedUid && requestedUid !== authUser.uid) {
        return json(res, 403, { error: "Forbidden for requested uid" });
      }
      const uid = authUser.uid;

      try {
        const billing = await getBillingRecord({ env, uid });
        return json(res, 200, {
          uid,
          billing: billing ?? null,
          active: String(billing?.status ?? "").toLowerCase() === "active",
        });
      } catch (error) {
        return json(res, 502, {
          error: "Failed to fetch subscription status",
          detail: String(error?.message ?? error),
        });
      }
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return json(res, 405, { error: "Method not allowed" });
    }

    if (!stripeSecretKey) {
      return json(res, 503, { error: "STRIPE_SECRET_KEY is not configured" });
    }

    const authUser = await requireAuthenticatedUser({
      req,
      res,
      apiKey: firebaseWebApiKey,
      timeoutMs: authTimeoutMs,
    });
    if (!authUser) {
      return;
    }

    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch (error) {
      return json(res, 400, { error: "Invalid JSON body" });
    }

    const baseUrl = getBaseAppUrl(req, env);

    if (requestUrl.pathname === "/api/billing/create-checkout-session") {
      const tier = normalizeTier(body?.tier, "");
      if (!tier) {
        return json(res, 400, { error: "Invalid or missing plan tier" });
      }

      const priceId = stripePriceIds[tier];
      if (!priceId) {
        return json(res, 503, {
          error: `Price ID for tier "${tier}" is not configured`,
          hint: `Set STRIPE_PRICE_${tier.toUpperCase()}_MONTHLY in your environment`,
        });
      }

      const uid = authUser.uid;
      const email = authUser.email;
      let stripeCustomerId = "";
      try {
        const existingBilling = (await getBillingRecord({ env, uid })) ?? {};
        stripeCustomerId = String(existingBilling?.stripeCustomerId ?? "").trim();
      } catch {
        stripeCustomerId = "";
      }
      const successUrl = toAbsoluteUrl(
        body?.successUrl || `/pricing?checkout=success&tier=${tier}&session_id={CHECKOUT_SESSION_ID}`,
        baseUrl
      );
      const cancelUrl = toAbsoluteUrl(
        body?.cancelUrl || `/pricing?checkout=cancel&tier=${tier}`,
        baseUrl
      );

      const formData = new URLSearchParams();
      formData.append("mode", "subscription");
      formData.append("line_items[0][price]", priceId);
      formData.append("line_items[0][quantity]", "1");
      formData.append("success_url", successUrl);
      formData.append("cancel_url", cancelUrl);
      formData.append("allow_promotion_codes", "true");
      if (uid) {
        formData.append("client_reference_id", uid);
        formData.append("metadata[user_uid]", uid);
      }
      if (email) {
        formData.append("metadata[user_email]", email);
      }
      formData.append("metadata[plan_tier]", tier);
      formData.append("subscription_data[metadata][plan_tier]", tier);
      if (uid) {
        formData.append("subscription_data[metadata][user_uid]", uid);
      }
      if (stripeCustomerId) {
        formData.append("customer", stripeCustomerId);
      } else if (email) {
        formData.append("customer_email", email);
      }

      try {
        const session = await stripeRequest({
          method: "POST",
          path: "/v1/checkout/sessions",
          secretKey: stripeSecretKey,
          timeoutMs,
          formData,
        });

        if (!session?.url) {
          return json(res, 502, { error: "Stripe did not return a checkout URL" });
        }

        return json(res, 200, {
          sessionId: session.id,
          checkoutUrl: session.url,
          tier,
        });
      } catch (error) {
        return json(res, 502, {
          error: "Failed to create Stripe checkout session",
          detail: String(error?.message ?? error),
        });
      }
    }

    if (requestUrl.pathname === "/api/billing/create-portal-session") {
      let customerId = "";
      try {
        const existingBilling = (await getBillingRecord({ env, uid: authUser.uid })) ?? {};
        customerId = String(existingBilling?.stripeCustomerId ?? "").trim();
      } catch {
        customerId = "";
      }
      if (!customerId) {
        return json(res, 400, { error: "No Stripe customer profile found. Start a checkout first." });
      }

      const returnUrl = toAbsoluteUrl(body?.returnUrl || "/pricing", baseUrl);
      const formData = new URLSearchParams();
      formData.append("customer", customerId);
      formData.append("return_url", returnUrl);

      try {
        const session = await stripeRequest({
          method: "POST",
          path: "/v1/billing_portal/sessions",
          secretKey: stripeSecretKey,
          timeoutMs,
          formData,
        });
        return json(res, 200, {
          portalUrl: session?.url ?? "",
        });
      } catch (error) {
        return json(res, 502, {
          error: "Failed to create Stripe billing portal session",
          detail: String(error?.message ?? error),
        });
      }
    }

    if (requestUrl.pathname === "/api/billing/verify-checkout-session") {
      const sessionId = String(body?.sessionId ?? "").trim();
      if (!sessionId) {
        return json(res, 400, { error: "Missing required field: sessionId" });
      }

      try {
        const session = await stripeRequest({
          method: "GET",
          path: `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
          secretKey: stripeSecretKey,
          timeoutMs,
        });

        const sessionUid = String(session?.metadata?.user_uid ?? session?.client_reference_id ?? "").trim();
        const sessionCustomerId = String(session?.customer ?? "").trim();
        if (sessionUid && sessionUid !== authUser.uid) {
          return json(res, 403, { error: "Checkout session does not belong to the authenticated user." });
        }
        if (!sessionUid) {
          const existingBilling = (await getBillingRecord({ env, uid: authUser.uid })) ?? {};
          const expectedCustomerId = String(existingBilling?.stripeCustomerId ?? "").trim();
          if (expectedCustomerId && sessionCustomerId && expectedCustomerId !== sessionCustomerId) {
            return json(res, 403, { error: "Checkout session does not match authenticated customer." });
          }
        }

        const status = String(session?.status ?? "").toLowerCase();
        const completed = status === "complete";
        const metadataTier = normalizeTier(session?.metadata?.plan_tier, "");
        const fallbackTier = normalizeTier(body?.tier, "basic");

        return json(res, 200, {
          completed,
          status,
          tier: metadataTier || fallbackTier,
          stripeCustomerId: String(session?.customer ?? "").trim(),
          stripeSubscriptionId: String(session?.subscription ?? "").trim(),
          customerEmail: String(session?.customer_details?.email ?? session?.metadata?.user_email ?? "").trim(),
        });
      } catch (error) {
        return json(res, 502, {
          error: "Failed to verify checkout session",
          detail: String(error?.message ?? error),
        });
      }
    }

    return json(res, 404, { error: "Billing endpoint not found" });
  };

  return {
    name: "stripe-billing-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
