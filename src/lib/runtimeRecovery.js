const MODULE_RECOVERY_MARKER_KEY = "tnv:module-recovery-ts";
const MODULE_RECOVERY_QUERY_PARAM = "__recover";
const MODULE_RECOVERY_COOLDOWN_MS = 30_000;

function safeToMessage(errorLike) {
  if (!errorLike) return "";
  if (typeof errorLike === "string") return errorLike;
  if (typeof errorLike?.message === "string") return errorLike.message;
  try {
    return JSON.stringify(errorLike);
  } catch {
    return String(errorLike);
  }
}

export function isModuleLoadFailure(errorLike) {
  const message = safeToMessage(errorLike).toLowerCase();
  if (!message) return false;

  return (
    message.includes("importing a module script failed") ||
    message.includes("failed to load module script") ||
    message.includes("failed to fetch dynamically imported module") ||
    message.includes("error loading dynamically imported module") ||
    message.includes("chunkloaderror") ||
    message.includes("loading chunk")
  );
}

export function clearModuleRecoveryMarker() {
  if (typeof window === "undefined") return;

  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has(MODULE_RECOVERY_QUERY_PARAM)) {
      url.searchParams.delete(MODULE_RECOVERY_QUERY_PARAM);
      const nextSearch = url.searchParams.toString();
      const nextPath = `${url.pathname}${nextSearch ? `?${nextSearch}` : ""}${url.hash}`;
      window.history.replaceState({}, "", nextPath);
    }
    window.sessionStorage.removeItem(MODULE_RECOVERY_MARKER_KEY);
  } catch {
    // Ignore storage/history errors; this cleanup is best-effort.
  }
}

export function triggerModuleRecoveryReload(reason = "") {
  if (typeof window === "undefined") return false;

  try {
    const now = Date.now();
    const lastAttempt = Number(window.sessionStorage.getItem(MODULE_RECOVERY_MARKER_KEY) ?? 0);
    if (Number.isFinite(lastAttempt) && lastAttempt > 0 && now - lastAttempt < MODULE_RECOVERY_COOLDOWN_MS) {
      return false;
    }

    window.sessionStorage.setItem(MODULE_RECOVERY_MARKER_KEY, String(now));
    const url = new URL(window.location.href);
    url.searchParams.set(MODULE_RECOVERY_QUERY_PARAM, String(now));
    if (reason) {
      url.searchParams.set("recover_reason", reason);
    }
    window.location.replace(url.toString());
    return true;
  } catch {
    return false;
  }
}

