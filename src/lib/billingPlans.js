export const BILLING_TIERS = {
  BASIC: "basic",
  PRO: "pro",
  PREMIUM: "premium",
};

export const BILLING_INTERVALS = {
  MONTH: "month",
  YEAR: "year",
};

export const BILLING_FEATURES = {
  BACKUP_TOOLS: "backup_tools",
  AUTO_SPEAK: "auto_speak",
  ADVANCED_INSIGHTS: "advanced_insights",
  PRIORITY_SUPPORT: "priority_support",
};

const PLAN_BY_TIER = {
  [BILLING_TIERS.BASIC]: {
    tier: BILLING_TIERS.BASIC,
    name: "Basic",
    subtitle: "Entry level",
    priceLabel: "$19/mo",
    priceByInterval: {
      [BILLING_INTERVALS.MONTH]: "$19/mo",
      [BILLING_INTERVALS.YEAR]: "$190/yr",
    },
    yearlySavingsLabel: "Save ~17%",
    description: "Essential communication tools for individuals and families starting out.",
    recommended: false,
    limits: {
      maxChildren: 1,
    },
    features: {
      [BILLING_FEATURES.BACKUP_TOOLS]: false,
      [BILLING_FEATURES.AUTO_SPEAK]: false,
      [BILLING_FEATURES.ADVANCED_INSIGHTS]: false,
      [BILLING_FEATURES.PRIORITY_SUPPORT]: false,
    },
    highlights: [
      "Core sentence builder and speaking controls",
      "Single child profile",
      "Smart suggestions baseline",
      "Community support",
    ],
  },
  [BILLING_TIERS.PRO]: {
    tier: BILLING_TIERS.PRO,
    name: "Pro",
    subtitle: "Most Popular",
    priceLabel: "$39/mo",
    priceByInterval: {
      [BILLING_INTERVALS.MONTH]: "$39/mo",
      [BILLING_INTERVALS.YEAR]: "$390/yr",
    },
    yearlySavingsLabel: "Save ~17%",
    description: "Full core platform for growing households and active therapy workflows.",
    recommended: true,
    limits: {
      maxChildren: 5,
    },
    features: {
      [BILLING_FEATURES.BACKUP_TOOLS]: true,
      [BILLING_FEATURES.AUTO_SPEAK]: true,
      [BILLING_FEATURES.ADVANCED_INSIGHTS]: true,
      [BILLING_FEATURES.PRIORITY_SUPPORT]: true,
    },
    highlights: [
      "Everything in Basic",
      "Up to 5 child profiles",
      "Backup import/export tools",
      "Auto-Speak and advanced insights",
    ],
  },
  [BILLING_TIERS.PREMIUM]: {
    tier: BILLING_TIERS.PREMIUM,
    name: "Premium",
    subtitle: "VIP power users",
    priceLabel: "$99/mo",
    priceByInterval: {
      [BILLING_INTERVALS.MONTH]: "$99/mo",
      [BILLING_INTERVALS.YEAR]: "$990/yr",
    },
    yearlySavingsLabel: "Save ~17%",
    description: "Unlimited flexibility and white-glove support for advanced teams.",
    recommended: false,
    limits: {
      maxChildren: 25,
    },
    features: {
      [BILLING_FEATURES.BACKUP_TOOLS]: true,
      [BILLING_FEATURES.AUTO_SPEAK]: true,
      [BILLING_FEATURES.ADVANCED_INSIGHTS]: true,
      [BILLING_FEATURES.PRIORITY_SUPPORT]: true,
    },
    highlights: [
      "Everything in Pro",
      "Up to 25 child profiles",
      "VIP priority support",
      "Best fit for power users and larger programs",
    ],
  },
};

export const BILLING_PLAN_ORDER = [
  PLAN_BY_TIER[BILLING_TIERS.BASIC],
  PLAN_BY_TIER[BILLING_TIERS.PRO],
  PLAN_BY_TIER[BILLING_TIERS.PREMIUM],
];

export function isKnownPlanTier(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized in PLAN_BY_TIER;
}

export function normalizePlanTier(value, fallback = BILLING_TIERS.BASIC) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return isKnownPlanTier(normalized) ? normalized : fallback;
}

export function normalizeBillingInterval(value, fallback = BILLING_INTERVALS.MONTH) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === BILLING_INTERVALS.MONTH || normalized === BILLING_INTERVALS.YEAR) {
    return normalized;
  }
  return fallback;
}

export function getBillingPlan(tier) {
  const safeTier = normalizePlanTier(tier);
  return PLAN_BY_TIER[safeTier];
}

export function getPlanPriceLabel(tier, interval = BILLING_INTERVALS.MONTH) {
  const safeInterval = normalizeBillingInterval(interval, BILLING_INTERVALS.MONTH);
  const plan = getBillingPlan(tier);
  return (
    plan?.priceByInterval?.[safeInterval] ??
    plan?.priceByInterval?.[BILLING_INTERVALS.MONTH] ??
    "$0/mo"
  );
}

export function getPlanLimit(tier, key) {
  const plan = getBillingPlan(tier);
  return plan?.limits?.[key];
}

export function planHasFeature(tier, featureKey) {
  const plan = getBillingPlan(tier);
  return Boolean(plan?.features?.[featureKey]);
}
