import { ROLES, hasAnyRole, normalizeRoles } from "../constants/roles";

const ROLE_HOME_PRIORITY = [
  { role: ROLES.ADMIN, path: "/admin" },
  { role: ROLES.THERAPIST, path: "/therapist" },
  { role: ROLES.PARENT, path: "/app" },
];

const PROTECTED_PATH_RULES = [
  { prefix: "/admin", roles: [ROLES.ADMIN] },
  { prefix: "/mco", roles: [ROLES.ADMIN] },
  { prefix: "/therapist", roles: [ROLES.THERAPIST, ROLES.ADMIN] },
];

const NON_TARGET_PATHS = new Set(["", "/", "/login", "/signup", "/unauthorized"]);

function normalizePath(value) {
  if (typeof value !== "string") return "";
  const [withoutQuery] = value.split(/[?#]/);
  const trimmed = withoutQuery.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveHomePath(userRoles = []) {
  const roles = normalizeRoles(userRoles);
  const firstMatch = ROLE_HOME_PRIORITY.find(({ role }) => roles.includes(role));
  return firstMatch?.path ?? "/app";
}

export function canAccessPath(path, userRoles = []) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) return false;

  const matchedRule = PROTECTED_PATH_RULES.find(
    ({ prefix }) => normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`)
  );

  if (!matchedRule) return true;
  return hasAnyRole(userRoles, matchedRule.roles);
}

export function resolvePostAuthPath({ requestedPath, userRoles = [], fallbackPath } = {}) {
  const defaultHomePath = resolveHomePath(userRoles);
  const normalizedFallback = normalizePath(fallbackPath);
  const safeFallback =
    normalizedFallback && canAccessPath(normalizedFallback, userRoles) ? normalizedFallback : defaultHomePath;

  const normalizedRequested = normalizePath(requestedPath);
  if (!normalizedRequested || NON_TARGET_PATHS.has(normalizedRequested)) {
    return safeFallback;
  }

  if (!canAccessPath(normalizedRequested, userRoles)) {
    return safeFallback;
  }

  return normalizedRequested;
}
