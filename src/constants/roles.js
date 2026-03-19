export const ROLES = {
  PARENT: "parent",
  THERAPIST: "therapist",
  ADMIN: "admin",
};

export const ALL_ROLES = [ROLES.PARENT, ROLES.THERAPIST, ROLES.ADMIN];

export function normalizeRoles(value) {
  if (!value) return [];

  const rawRoles = Array.isArray(value) ? value : [value];
  const cleaned = rawRoles
    .map((role) => String(role).trim().toLowerCase())
    .filter((role) => ALL_ROLES.includes(role));

  return [...new Set(cleaned)];
}

export function hasAnyRole(userRoles, requiredRoles) {
  const activeRoles = normalizeRoles(userRoles);
  const needsRoles = normalizeRoles(requiredRoles);

  if (needsRoles.length === 0) return true;

  return needsRoles.some((role) => activeRoles.includes(role));
}
