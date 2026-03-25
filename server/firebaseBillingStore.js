import { createSign } from "node:crypto";

const GOOGLE_OAUTH_SCOPE = "https://www.googleapis.com/auth/datastore";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const SUPABASE_DEFAULT_BILLING_TABLE = "billing_profiles";

const memoryBillingByUid = new Map();
const memoryUidByCustomer = new Map();

let cachedGoogleAccessToken = "";
let cachedGoogleAccessTokenExp = 0;

function normalizePrivateKey(raw) {
  return String(raw ?? "")
    .replace(/\\n/g, "\n")
    .trim();
}

function hasServiceAccountConfig(env = {}) {
  return Boolean(
    String(env.FIREBASE_ADMIN_PROJECT_ID ?? "").trim() &&
      String(env.FIREBASE_ADMIN_CLIENT_EMAIL ?? "").trim() &&
      normalizePrivateKey(env.FIREBASE_ADMIN_PRIVATE_KEY)
  );
}

function hasSupabaseConfig(env = {}) {
  return Boolean(
    String(env.SUPABASE_URL ?? "").trim() && String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()
  );
}

function getSupabaseBillingTable(env = {}) {
  const raw = String(env.SUPABASE_BILLING_TABLE ?? "").trim();
  if (!raw) return SUPABASE_DEFAULT_BILLING_TABLE;
  return /^[A-Za-z0-9_.-]+$/.test(raw) ? raw : SUPABASE_DEFAULT_BILLING_TABLE;
}

function getSupabaseBaseUrl(env = {}) {
  return String(env.SUPABASE_URL ?? "").trim().replace(/\/+$/, "");
}

function getSupabaseServiceRoleKey(env = {}) {
  return String(env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
}

function toSupabaseErrorMessage(payload, response) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const detail = String(
      payload.message ??
        payload.error_description ??
        payload.error ??
        payload.hint ??
        payload.code ??
        ""
    ).trim();
    if (detail) return detail;
  }
  return String(response?.statusText ?? "unknown").trim() || "unknown";
}

function normalizeBillingFromSupabaseRow(row = {}) {
  return {
    tier: String(row.tier ?? "basic").trim().toLowerCase(),
    status: String(row.status ?? "inactive").trim().toLowerCase(),
    stripeCustomerId: String(row.stripe_customer_id ?? row.stripeCustomerId ?? "").trim(),
    stripeSubscriptionId: String(row.stripe_subscription_id ?? row.stripeSubscriptionId ?? "").trim(),
    lastCheckoutSessionId: String(
      row.last_checkout_session_id ?? row.lastCheckoutSessionId ?? ""
    ).trim(),
    lastStripeEventId: String(row.last_stripe_event_id ?? row.lastStripeEventId ?? "").trim(),
    updatedAt: String(row.updated_at ?? row.updatedAt ?? new Date().toISOString()),
  };
}

function toSupabaseBillingRow(uid, billing = {}) {
  return {
    uid: String(uid ?? "").trim(),
    tier: String(billing.tier ?? "basic").trim().toLowerCase(),
    status: String(billing.status ?? "inactive").trim().toLowerCase(),
    stripe_customer_id: String(billing.stripeCustomerId ?? "").trim() || null,
    stripe_subscription_id: String(billing.stripeSubscriptionId ?? "").trim() || null,
    last_checkout_session_id: String(billing.lastCheckoutSessionId ?? "").trim() || null,
    last_stripe_event_id: String(billing.lastStripeEventId ?? "").trim() || null,
    updated_at: String(billing.updatedAt ?? new Date().toISOString()),
  };
}

async function supabaseRequest({ env = {}, method = "GET", path, body = null, headers: extraHeaders = {} }) {
  const baseUrl = getSupabaseBaseUrl(env);
  const serviceRoleKey = getSupabaseServiceRoleKey(env);
  const url = `${baseUrl}${path}`;
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
    ...extraHeaders,
  };
  const options = { method, headers };

  if (body !== null) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Supabase request failed: ${toSupabaseErrorMessage(payload, response)}`);
  }
  return payload;
}

async function supabaseUpsertBilling(env = {}, uid, billing) {
  const table = getSupabaseBillingTable(env);
  const row = toSupabaseBillingRow(uid, billing);
  const payload = await supabaseRequest({
    env,
    method: "POST",
    path: `/rest/v1/${table}`,
    body: [row],
    headers: {
      Prefer: "resolution=merge-duplicates,return=representation",
    },
  });

  const normalized = normalizeBillingFromSupabaseRow(Array.isArray(payload) ? payload[0] ?? row : row);
  upsertMemoryBilling(uid, normalized);
  return normalized;
}

async function supabaseGetBilling(env = {}, uid) {
  const table = getSupabaseBillingTable(env);
  const encodedUid = encodeURIComponent(String(uid ?? "").trim());
  const payload = await supabaseRequest({
    env,
    method: "GET",
    path:
      `/rest/v1/${table}?uid=eq.${encodedUid}` +
      "&select=uid,tier,status,stripe_customer_id,stripe_subscription_id,last_checkout_session_id,last_stripe_event_id,updated_at&limit=1",
  });

  if (!Array.isArray(payload) || payload.length === 0) return null;
  const normalized = normalizeBillingFromSupabaseRow(payload[0]);
  upsertMemoryBilling(uid, normalized);
  return normalized;
}

async function supabaseGetUidForCustomer(env = {}, customerId) {
  const table = getSupabaseBillingTable(env);
  const encodedCustomerId = encodeURIComponent(String(customerId ?? "").trim());
  if (!encodedCustomerId) return "";

  const payload = await supabaseRequest({
    env,
    method: "GET",
    path: `/rest/v1/${table}?stripe_customer_id=eq.${encodedCustomerId}&select=uid&limit=1`,
  });

  if (!Array.isArray(payload) || payload.length === 0) return "";
  const uid = String(payload[0]?.uid ?? "").trim();
  if (uid) {
    memoryUidByCustomer.set(String(customerId).trim(), uid);
  }
  return uid;
}

function base64urlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function getGoogleAccessToken(env = {}) {
  const now = Math.floor(Date.now() / 1000);
  if (cachedGoogleAccessToken && cachedGoogleAccessTokenExp - 60 > now) {
    return cachedGoogleAccessToken;
  }

  const projectId = String(env.FIREBASE_ADMIN_PROJECT_ID ?? "").trim();
  const clientEmail = String(env.FIREBASE_ADMIN_CLIENT_EMAIL ?? "").trim();
  const privateKey = normalizePrivateKey(env.FIREBASE_ADMIN_PRIVATE_KEY);
  const tokenUri = String(env.FIREBASE_ADMIN_TOKEN_URI ?? GOOGLE_TOKEN_URL).trim() || GOOGLE_TOKEN_URL;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error("Firebase Admin service account environment variables are missing.");
  }

  const issuedAt = now;
  const expiresAt = now + 3600;
  const unsignedToken = `${base64urlJson({ alg: "RS256", typ: "JWT" })}.${base64urlJson({
    iss: clientEmail,
    scope: GOOGLE_OAUTH_SCOPE,
    aud: tokenUri,
    iat: issuedAt,
    exp: expiresAt,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsignedToken).sign(privateKey, "base64url");
  const assertion = `${unsignedToken}.${signature}`;

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(payload?.error_description ?? payload?.error ?? response.statusText ?? "unknown").trim();
    throw new Error(`Failed to fetch Google access token: ${detail}`);
  }

  cachedGoogleAccessToken = String(payload.access_token ?? "").trim();
  const expiresIn = Number(payload.expires_in ?? 3600);
  cachedGoogleAccessTokenExp = now + (Number.isFinite(expiresIn) ? expiresIn : 3600);

  if (!cachedGoogleAccessToken) {
    throw new Error("Google token response did not include access_token.");
  }

  return cachedGoogleAccessToken;
}

function toFirestoreValue(value) {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((entry) => toFirestoreValue(entry)) } };
  }
  if (typeof value === "object") {
    const fields = {};
    for (const [key, nested] of Object.entries(value)) {
      if (!key) continue;
      fields[key] = toFirestoreValue(nested);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value) {
  if (!value || typeof value !== "object") return null;
  if ("stringValue" in value) return String(value.stringValue ?? "");
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("integerValue" in value) return Number.parseInt(String(value.integerValue), 10) || 0;
  if ("doubleValue" in value) return Number(value.doubleValue ?? 0);
  if ("timestampValue" in value) return String(value.timestampValue ?? "");
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) {
    return Array.isArray(value.arrayValue?.values)
      ? value.arrayValue.values.map((entry) => fromFirestoreValue(entry))
      : [];
  }
  if ("mapValue" in value) {
    const fields = value.mapValue?.fields ?? {};
    const result = {};
    for (const [key, nested] of Object.entries(fields)) {
      result[key] = fromFirestoreValue(nested);
    }
    return result;
  }
  return null;
}

function getUserDocumentUrl(env = {}, uid) {
  const projectId = String(env.FIREBASE_ADMIN_PROJECT_ID ?? "").trim();
  const encodedUid = encodeURIComponent(String(uid ?? "").trim());
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    projectId
  )}/databases/(default)/documents/users/${encodedUid}`;
}

async function firestorePatchBilling(env = {}, uid, billing) {
  const token = await getGoogleAccessToken(env);
  const url = `${getUserDocumentUrl(env, uid)}?updateMask.fieldPaths=billing`;
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      fields: {
        billing: toFirestoreValue(billing),
      },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(payload?.error?.message ?? response.statusText ?? "unknown").trim();
    throw new Error(`Firestore billing patch failed: ${detail}`);
  }
  return payload;
}

async function firestoreGetBilling(env = {}, uid) {
  const token = await getGoogleAccessToken(env);
  const url = getUserDocumentUrl(env, uid);
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    const detail = String(payload?.error?.message ?? response.statusText ?? "unknown").trim();
    throw new Error(`Firestore billing fetch failed: ${detail}`);
  }
  const billingValue = payload?.fields?.billing;
  if (!billingValue) return null;
  return fromFirestoreValue(billingValue);
}

function upsertMemoryBilling(uid, billing) {
  const safeUid = String(uid ?? "").trim();
  if (!safeUid) return;
  const nextRecord = {
    ...billing,
    updatedAt: String(billing?.updatedAt ?? new Date().toISOString()),
  };
  memoryBillingByUid.set(safeUid, nextRecord);
  const customerId = String(nextRecord?.stripeCustomerId ?? "").trim();
  if (customerId) {
    memoryUidByCustomer.set(customerId, safeUid);
  }
}

export function getUidForStripeCustomer(customerId) {
  const safeCustomerId = String(customerId ?? "").trim();
  if (!safeCustomerId) return "";
  return memoryUidByCustomer.get(safeCustomerId) ?? "";
}

export async function getUidForStripeCustomerAsync({ env = {}, customerId }) {
  const safeCustomerId = String(customerId ?? "").trim();
  if (!safeCustomerId) return "";
  const memoryUid = memoryUidByCustomer.get(safeCustomerId) ?? "";
  if (memoryUid) return memoryUid;

  if (!hasSupabaseConfig(env)) {
    return "";
  }

  try {
    return await supabaseGetUidForCustomer(env, safeCustomerId);
  } catch (error) {
    console.error("Supabase stripe-customer lookup failed:", error);
    return "";
  }
}

export async function persistBillingRecord({ env = {}, uid, billing }) {
  const safeUid = String(uid ?? "").trim();
  if (!safeUid) {
    throw new Error("User UID is required for billing persistence.");
  }

  const safeBilling = {
    tier: String(billing?.tier ?? "basic").trim().toLowerCase(),
    status: String(billing?.status ?? "inactive").trim().toLowerCase(),
    stripeCustomerId: String(billing?.stripeCustomerId ?? "").trim(),
    stripeSubscriptionId: String(billing?.stripeSubscriptionId ?? "").trim(),
    lastCheckoutSessionId: String(billing?.lastCheckoutSessionId ?? "").trim(),
    lastStripeEventId: String(billing?.lastStripeEventId ?? "").trim(),
    updatedAt: String(billing?.updatedAt ?? new Date().toISOString()),
  };

  upsertMemoryBilling(safeUid, safeBilling);

  if (hasSupabaseConfig(env)) {
    try {
      const supabaseBilling = await supabaseUpsertBilling(env, safeUid, safeBilling);
      return { persisted: true, mode: "supabase", billing: supabaseBilling };
    } catch (error) {
      console.error("Supabase billing persistence failed, falling back:", error);
    }
  }

  if (!hasServiceAccountConfig(env)) {
    return { persisted: false, mode: "memory", billing: safeBilling };
  }

  await firestorePatchBilling(env, safeUid, safeBilling);
  return { persisted: true, mode: "firestore", billing: safeBilling };
}

export async function getBillingRecord({ env = {}, uid }) {
  const safeUid = String(uid ?? "").trim();
  if (!safeUid) return null;

  if (hasSupabaseConfig(env)) {
    try {
      const supabaseBilling = await supabaseGetBilling(env, safeUid);
      if (supabaseBilling) {
        return supabaseBilling;
      }
    } catch (error) {
      console.error("Supabase billing fetch failed, falling back:", error);
    }
  }

  if (hasServiceAccountConfig(env)) {
    const firestoreBilling = await firestoreGetBilling(env, safeUid);
    if (firestoreBilling) {
      upsertMemoryBilling(safeUid, firestoreBilling);
      return firestoreBilling;
    }
  }

  return memoryBillingByUid.get(safeUid) ?? null;
}
