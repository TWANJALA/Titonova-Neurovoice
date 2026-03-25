import { auth } from "../firebase";

function toErrorMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    const message = String(payload.error ?? payload.message ?? "").trim();
    if (message) return message;
  }
  return fallback;
}

async function createAuthHeaders(baseHeaders = {}) {
  const headers = { ...baseHeaders };
  const currentUser = auth?.currentUser ?? null;
  if (!currentUser) return headers;

  try {
    const token = await currentUser.getIdToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // Auth token attachment is best effort; server will enforce auth for protected endpoints.
  }

  return headers;
}

async function postJson(path, body = {}) {
  const headers = await createAuthHeaders({
    "Content-Type": "application/json",
    Accept: "application/json",
  });

  const response = await fetch(path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(toErrorMessage(payload, `Request failed (${response.status})`));
  }
  return payload;
}

async function getJson(path) {
  const headers = await createAuthHeaders({
    Accept: "application/json",
  });

  const response = await fetch(path, {
    method: "GET",
    headers,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(toErrorMessage(payload, `Request failed (${response.status})`));
  }
  return payload;
}

export function createCheckoutSession(payload) {
  return postJson("/api/billing/create-checkout-session", payload);
}

export function createPortalSession(payload) {
  return postJson("/api/billing/create-portal-session", payload);
}

export function getSubscriptionStatus() {
  return getJson("/api/billing/subscription-status");
}

export function getBillingHealth() {
  return getJson("/api/billing/health");
}
