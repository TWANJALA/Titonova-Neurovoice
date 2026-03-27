import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { getBillingHealth, getSubscriptionStatus } from "../lib/billingClient";
import {
  BILLING_INTERVALS,
  BILLING_PLAN_ORDER,
  getBillingPlan,
  getPlanPriceLabel,
  normalizeBillingInterval,
  normalizePlanTier,
} from "../lib/billingPlans";

function formatTierName(tier) {
  return getBillingPlan(tier).name;
}

function isActiveSubscriptionStatus(status) {
  const normalized = String(status ?? "").trim().toLowerCase();
  return normalized === "active" || normalized === "trialing" || normalized === "past_due";
}

export default function PricingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    loading,
    user,
    planTier,
    subscriptionStatus,
    stripeCustomerId,
    startCheckout,
    openBillingPortal,
    refreshAccess,
  } = useAuth();

  const [busyKey, setBusyKey] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [billingInterval, setBillingInterval] = useState(BILLING_INTERVALS.MONTH);
  const [billingHealth, setBillingHealth] = useState(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [fitScale, setFitScale] = useState(1);
  const pricingContentRef = useRef(null);

  const query = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const checkoutStatus = String(query.get("checkout") ?? "").trim().toLowerCase();
  const checkoutTier = normalizePlanTier(query.get("tier"), planTier);
  const checkoutInterval = normalizeBillingInterval(query.get("interval"), billingInterval);
  const checkoutSessionId = String(query.get("session_id") ?? "").trim();

  useEffect(() => {
    const requestedInterval = String(query.get("interval") ?? "").trim().toLowerCase();
    if (!requestedInterval) return;
    setBillingInterval(normalizeBillingInterval(requestedInterval, BILLING_INTERVALS.MONTH));
  }, [query]);

  useEffect(() => {
    let active = true;
    getBillingHealth()
      .then((health) => {
        if (!active) return;
        setBillingHealth(health ?? null);
      })
      .catch(() => {
        if (!active) return;
        setBillingHealth(null);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const syncViewport = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    syncViewport();
    window.addEventListener("resize", syncViewport);
    return () => {
      window.removeEventListener("resize", syncViewport);
    };
  }, []);

  useEffect(() => {
    const target = pricingContentRef.current;
    if (!target) return;

    let rafId = 0;
    const computeFitScale = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const viewportHeight = window.innerHeight;
        const contentHeight = target.scrollHeight;
        if (!viewportHeight || !contentHeight) return;
        const available = Math.max(420, viewportHeight - 8);
        const nextScale =
          contentHeight <= available ? 1 : Math.max(0.72, Math.min(1, available / contentHeight));
        setFitScale(Number(nextScale.toFixed(3)));
      });
    };

    computeFitScale();
    window.addEventListener("resize", computeFitScale);

    let observer = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(computeFitScale);
      observer.observe(target);
    }

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener("resize", computeFitScale);
      if (observer) observer.disconnect();
    };
  }, [billingInterval, loading, error, message, busyKey, checkoutStatus, planTier, subscriptionStatus]);

  useEffect(() => {
    if (checkoutStatus !== "success") return;
    if (!checkoutSessionId) return;
    if (!user) return;

    let active = true;

    const syncCheckout = async () => {
      setBusyKey("sync");
      setError("");
      setMessage("");

      try {
        const expectedTier = normalizePlanTier(checkoutTier, planTier);
        let activated = false;
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const status = await getSubscriptionStatus();
          if (!active) return;
          const serverStatus = String(status?.billing?.status ?? "").trim().toLowerCase();
          const serverTier = normalizePlanTier(status?.billing?.tier, expectedTier);
          if (serverStatus === "active" && serverTier === expectedTier) {
            activated = true;
            break;
          }
          await new Promise((resolve) => {
            window.setTimeout(resolve, 1500);
          });
        }

        if (!active) return;
        if (activated) {
          await refreshAccess();
          const intervalName =
            checkoutInterval === BILLING_INTERVALS.YEAR ? "annual" : "monthly";
          setMessage(`${formatTierName(expectedTier)} ${intervalName} plan is now active.`);
        } else {
          setMessage(
            "Checkout completed. Activation webhook is still processing; refresh this page in a few seconds."
          );
        }
      } catch (syncError) {
        if (!active) return;
        setError(syncError.message || "Failed to verify checkout session.");
      } finally {
        if (active) setBusyKey("");
      }
    };

    syncCheckout();
    return () => {
      active = false;
    };
  }, [
    checkoutStatus,
    checkoutSessionId,
    checkoutTier,
    checkoutInterval,
    user,
    stripeCustomerId,
    refreshAccess,
    planTier,
  ]);

  async function handleCheckout(tier, interval) {
    const checkoutKey = `${tier}:${interval}`;
    setBusyKey(checkoutKey);
    setError("");
    setMessage("");

    try {
      if (!user) {
        setBusyKey("");
        navigate(`/signup?plan=${tier}`);
        return;
      }

      const session = await startCheckout({
        tier,
        interval,
        successPath: `/pricing?checkout=success&tier=${tier}&interval=${interval}&session_id={CHECKOUT_SESSION_ID}`,
        cancelPath: `/pricing?checkout=cancel&tier=${tier}&interval=${interval}`,
      });
      if (!session?.checkoutUrl) {
        throw new Error("Stripe checkout URL is missing.");
      }
      window.location.assign(session.checkoutUrl);
    } catch (checkoutError) {
      setError(checkoutError.message || "Failed to start checkout.");
      setBusyKey("");
    }
  }

  async function handleOpenPortal() {
    setBusyKey("portal");
    setError("");
    setMessage("");

    try {
      const session = await openBillingPortal({ returnPath: "/pricing" });
      if (!session?.portalUrl) {
        throw new Error("Stripe billing portal URL is missing.");
      }
      window.location.assign(session.portalUrl);
    } catch (portalError) {
      setError(portalError.message || "Unable to open billing portal.");
      setBusyKey("");
    }
  }

  const isBusy = (key) => busyKey === key;
  const isAnnual = billingInterval === BILLING_INTERVALS.YEAR;
  const hasActiveSubscription = isActiveSubscriptionStatus(subscriptionStatus);
  const isMobile = viewport.width > 0 && viewport.width < 700;
  const isTablet = viewport.width >= 700 && viewport.width < 1024;
  const isLaptopCompact =
    viewport.height >= 700 &&
    viewport.height <= 950 &&
    viewport.width >= 1024;
  const useThreeColumnCompactCards = isLaptopCompact && viewport.width >= 1180;
  const annualBadgeText = "Annual billing usually reduces total cost.";

  const resolvedPageStyle = isMobile
    ? mobilePageStyle
    : isTablet
      ? tabletPageStyle
      : isLaptopCompact
        ? compactPageStyle
        : pageStyle;
  const resolvedHeroStyle = isMobile
    ? mobileHeroStyle
    : isTablet
      ? tabletHeroStyle
      : isLaptopCompact
        ? compactHeroStyle
        : heroStyle;
  const resolvedTitleStyle = isMobile
    ? mobileTitleStyle
    : isTablet
      ? tabletTitleStyle
      : isLaptopCompact
        ? compactTitleStyle
        : titleStyle;
  const resolvedSubtitleStyle = isMobile
    ? mobileSubtitleStyle
    : isTablet
      ? tabletSubtitleStyle
      : isLaptopCompact
        ? compactSubtitleStyle
        : subtitleStyle;
  const resolvedHeroActionsStyle = isMobile
    ? mobileHeroActionsStyle
    : isTablet
      ? tabletHeroActionsStyle
      : isLaptopCompact
        ? compactHeroActionsStyle
        : heroActionsStyle;
  const resolvedIntervalToggleStyle = isMobile
    ? mobileIntervalToggleStyle
    : isTablet
      ? tabletIntervalToggleStyle
      : isLaptopCompact
        ? compactIntervalToggleStyle
        : intervalToggleStyle;
  const resolvedToggleButtonStyle = isMobile
    ? mobileToggleButtonStyle
    : isTablet
      ? tabletToggleButtonStyle
      : isLaptopCompact
        ? compactToggleButtonStyle
        : toggleButtonStyle;
  const resolvedToggleActiveStyle = isMobile
    ? mobileToggleActiveStyle
    : isTablet
      ? tabletToggleActiveStyle
      : isLaptopCompact
        ? compactToggleActiveStyle
        : toggleActiveStyle;
  const resolvedAnnualBadgeStyle = isMobile
    ? mobileAnnualBadgeStyle
    : isTablet
      ? tabletAnnualBadgeStyle
      : isLaptopCompact
        ? compactAnnualBadgeStyle
        : annualBadgeStyle;
  const resolvedMetaStyle = isMobile
    ? mobileMetaStyle
    : isTablet
      ? tabletMetaStyle
      : isLaptopCompact
        ? compactMetaStyle
        : metaStyle;
  const resolvedWarningStyle = isMobile
    ? mobileWarningStyle
    : isTablet
      ? tabletWarningStyle
      : isLaptopCompact
        ? compactWarningStyle
        : warningStyle;
  const resolvedErrorStyle = isMobile
    ? mobileErrorStyle
    : isTablet
      ? tabletErrorStyle
      : isLaptopCompact
        ? compactErrorStyle
        : errorStyle;
  const resolvedSuccessStyle = isMobile
    ? mobileSuccessStyle
    : isTablet
      ? tabletSuccessStyle
      : isLaptopCompact
        ? compactSuccessStyle
        : successStyle;
  const resolvedCommerceStripStyle = isMobile
    ? mobileCommerceStripStyle
    : isTablet
      ? tabletCommerceStripStyle
      : isLaptopCompact
        ? compactCommerceStripStyle
        : commerceStripStyle;
  const resolvedCommerceStripTextStyle = isMobile
    ? mobileCommerceStripTextStyle
    : isTablet
      ? tabletCommerceStripTextStyle
      : isLaptopCompact
        ? compactCommerceStripTextStyle
        : commerceStripTextStyle;
  const resolvedPlanGridStyle = isMobile
    ? mobilePlanGridStyle
    : isTablet
      ? tabletPlanGridStyle
      : useThreeColumnCompactCards
        ? compactPlanGridThreeColumnStyle
        : isLaptopCompact
          ? compactPlanGridStyle
          : planGridStyle;
  const resolvedGhostButtonStyle = isMobile
    ? mobileGhostButtonStyle
    : isTablet
      ? tabletGhostButtonStyle
      : isLaptopCompact
        ? compactGhostButtonStyle
        : ghostButtonStyle;
  const resolvedSolidButtonStyle = isMobile
    ? mobileSolidButtonStyle
    : isTablet
      ? tabletSolidButtonStyle
      : isLaptopCompact
        ? compactSolidButtonStyle
        : solidButtonStyle;
  const resolvedCurrentPlanButtonStyle = isMobile
    ? mobileCurrentPlanButtonStyle
    : isTablet
      ? tabletCurrentPlanButtonStyle
      : isLaptopCompact
        ? compactCurrentPlanButtonStyle
        : currentPlanButtonStyle;
  const resolvedCheckoutButtonStyle = isMobile
    ? mobileCheckoutButtonStyle
    : isTablet
      ? tabletCheckoutButtonStyle
      : isLaptopCompact
        ? compactCheckoutButtonStyle
        : checkoutButtonStyle;
  const resolvedAnnualFallbackStyle = isMobile
    ? mobileAnnualFallbackStyle
    : isTablet
      ? tabletAnnualFallbackStyle
      : isLaptopCompact
        ? compactAnnualFallbackStyle
        : annualFallbackStyle;

  const useCompactPlanCard = isMobile || isTablet || isLaptopCompact;
  const resolvedPlanTitleStyle = isMobile
    ? mobilePlanTitleStyle
    : isTablet
      ? tabletPlanTitleStyle
      : isLaptopCompact
        ? compactPlanTitleStyle
        : planTitleStyle;
  const resolvedPopularBadgeStyle = isMobile
    ? mobilePopularBadgeStyle
    : isTablet
      ? tabletPopularBadgeStyle
      : isLaptopCompact
        ? compactPopularBadgeStyle
        : popularBadgeStyle;
  const resolvedPlanSubtitleStyle = isMobile
    ? mobilePlanSubtitleStyle
    : isTablet
      ? tabletPlanSubtitleStyle
      : isLaptopCompact
        ? compactPlanSubtitleStyle
        : planSubtitleStyle;
  const resolvedPriceStyle = isMobile
    ? mobilePriceStyle
    : isTablet
      ? tabletPriceStyle
      : isLaptopCompact
        ? compactPriceStyle
        : priceStyle;
  const resolvedSavingsStyle = isMobile
    ? mobileSavingsStyle
    : isTablet
      ? tabletSavingsStyle
      : isLaptopCompact
        ? compactSavingsStyle
        : savingsStyle;
  const resolvedPlanDescriptionStyle = isMobile
    ? mobilePlanDescriptionStyle
    : isTablet
      ? tabletPlanDescriptionStyle
      : isLaptopCompact
        ? compactPlanDescriptionStyle
        : planDescriptionStyle;
  const resolvedFeatureListStyle = isMobile
    ? mobileFeatureListStyle
    : isTablet
      ? tabletFeatureListStyle
      : isLaptopCompact
        ? compactFeatureListStyle
        : featureListStyle;

  const fitScaleStyle = isLaptopCompact && fitScale < 0.999
    ? {
        transform: `scale(${fitScale})`,
        transformOrigin: "top center",
        width: `${(100 / fitScale).toFixed(3)}%`,
        margin: "0 auto",
      }
    : null;

  return (
    <main style={resolvedPageStyle}>
      <div ref={pricingContentRef} style={fitScaleStyle ?? undefined}>
      <section style={resolvedHeroStyle}>
        <p style={eyebrowStyle}>Billing</p>
        <h1 style={resolvedTitleStyle}>Choose your Titonova NeuroVoice plan</h1>
        <p style={resolvedSubtitleStyle}>
          Global checkout with tax/VAT capture, annual billing support, and plans optimized for households and therapy teams.
        </p>
        <div style={resolvedHeroActionsStyle}>
          <Link to="/app" style={resolvedGhostButtonStyle}>
            Back to workspace
          </Link>
          {user && stripeCustomerId ? (
            <button
              type="button"
              onClick={handleOpenPortal}
              disabled={isBusy("portal")}
              style={resolvedSolidButtonStyle}
            >
              {isBusy("portal") ? "Opening portal..." : "Manage Billing"}
            </button>
          ) : null}
          <a
            href="mailto:tituswanjala89@gmail.com?subject=Titonova%20NeuroVoice%20Global%20Plan%20Inquiry"
            style={resolvedGhostButtonStyle}
          >
            Contact Sales
          </a>
        </div>
        <p style={resolvedMetaStyle}>
          Direct contact: <strong>Titus Wanjala</strong> •{" "}
          <a href="tel:+15157790523" style={phoneLinkStyle}>
            515-779-0523
          </a>
          {" • "}
          <a href="mailto:tituswanjala89@gmail.com" style={phoneLinkStyle}>
            tituswanjala89@gmail.com
          </a>
        </p>
        <div style={resolvedIntervalToggleStyle}>
          <button
            type="button"
            onClick={() => setBillingInterval(BILLING_INTERVALS.MONTH)}
            disabled={busyKey !== ""}
            style={billingInterval === BILLING_INTERVALS.MONTH ? resolvedToggleActiveStyle : resolvedToggleButtonStyle}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingInterval(BILLING_INTERVALS.YEAR)}
            disabled={busyKey !== ""}
            style={billingInterval === BILLING_INTERVALS.YEAR ? resolvedToggleActiveStyle : resolvedToggleButtonStyle}
          >
            Yearly
          </button>
          {isAnnual ? <span style={resolvedAnnualBadgeStyle}>{annualBadgeText}</span> : null}
        </div>
        <p style={resolvedMetaStyle}>
          Current plan:{" "}
          <strong>{formatTierName(planTier)}</strong>
          {!hasActiveSubscription ? " (not activated yet)" : ""}
        </p>
        {loading ? <p style={resolvedMetaStyle}>Loading account...</p> : null}
        {checkoutStatus === "cancel" ? <p style={resolvedWarningStyle}>Checkout canceled. No changes were made.</p> : null}
        {error ? <p style={resolvedErrorStyle}>{error}</p> : null}
        {message ? <p style={resolvedSuccessStyle}>{message}</p> : null}
      </section>

      <section style={resolvedCommerceStripStyle}>
        <p style={resolvedCommerceStripTextStyle}>Global card-ready checkout</p>
        <p style={resolvedCommerceStripTextStyle}>Tax/VAT information captured during purchase</p>
        <p style={resolvedCommerceStripTextStyle}>Promotion codes and billing portal enabled</p>
      </section>

      <section style={resolvedPlanGridStyle}>
        {BILLING_PLAN_ORDER.map((plan) => {
          const isCurrentPlan = hasActiveSubscription && plan.tier === planTier;
          const planIntervalSupport =
            billingHealth?.plansConfigured?.[plan.tier] ?? {};
          const isIntervalReady =
            billingInterval === BILLING_INTERVALS.YEAR
              ? Boolean(planIntervalSupport?.year)
              : Boolean(planIntervalSupport?.month ?? true);
          const checkoutKey = `${plan.tier}:${billingInterval}`;
          const isPlanBusy = isBusy(checkoutKey);

          return (
            <article
              key={plan.tier}
              style={
                useCompactPlanCard
                  ? isMobile
                    ? mobilePlanCardStyle(isCurrentPlan, plan.recommended)
                    : isTablet
                      ? tabletPlanCardStyle(isCurrentPlan, plan.recommended)
                      : compactPlanCardStyle(isCurrentPlan, plan.recommended)
                  : planCardStyle(isCurrentPlan, plan.recommended)
              }
            >
              <div style={planHeaderStyle}>
                <h2 style={resolvedPlanTitleStyle}>{plan.name}</h2>
                {plan.recommended ? <span style={resolvedPopularBadgeStyle}>Most Popular</span> : null}
              </div>
              <p style={resolvedPlanSubtitleStyle}>{plan.subtitle}</p>
              <p style={resolvedPriceStyle}>{getPlanPriceLabel(plan.tier, billingInterval)}</p>
              {isAnnual ? <p style={resolvedSavingsStyle}>{plan.yearlySavingsLabel}</p> : null}
              <p style={resolvedPlanDescriptionStyle}>{plan.description}</p>
              <ul style={resolvedFeatureListStyle}>
                {plan.highlights.map((item) => (
                  <li key={`${plan.tier}-${item}`}>{item}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => handleCheckout(plan.tier, billingInterval)}
                disabled={isCurrentPlan || busyKey !== "" || !isIntervalReady}
                style={isCurrentPlan ? resolvedCurrentPlanButtonStyle : resolvedCheckoutButtonStyle}
              >
                {isCurrentPlan
                  ? "Current Plan"
                  : !isIntervalReady
                    ? "Not Configured Yet"
                    : isPlanBusy
                    ? "Redirecting..."
                    : `Choose ${plan.name}`}
              </button>
              {!isIntervalReady && isAnnual ? (
                <p style={resolvedAnnualFallbackStyle}>
                  Annual billing for this tier is not configured yet. Use monthly now or contact sales.
                </p>
              ) : null}
            </article>
          );
        })}
      </section>
      </div>
    </main>
  );
}

const pageStyle = {
  minHeight: "100vh",
  padding: "18px min(3vw, 28px) 26px",
  background:
    "radial-gradient(980px 440px at 5% -8%, rgba(66, 145, 255, 0.3) 0%, transparent 62%), radial-gradient(760px 400px at 100% 0%, rgba(52, 214, 175, 0.2) 0%, transparent 66%), linear-gradient(165deg, #020817 0%, #06152d 44%, #0d2446 100%)",
  color: "#e8f4ff",
};

const heroStyle = {
  maxWidth: 960,
  margin: "0 auto 12px",
  padding: 18,
  borderRadius: 18,
  border: "1px solid rgba(141, 186, 236, 0.42)",
  background: "linear-gradient(165deg, rgba(8, 24, 47, 0.88), rgba(8, 21, 41, 0.92))",
  boxShadow: "0 16px 34px rgba(2, 9, 20, 0.44)",
};

const eyebrowStyle = {
  margin: 0,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  fontSize: 12,
  color: "#9ec5e9",
  fontWeight: 700,
};

const titleStyle = {
  marginTop: 8,
  marginBottom: 8,
  lineHeight: 1.08,
  fontSize: "clamp(1.55rem, 3.2vw, 2.3rem)",
};

const subtitleStyle = {
  margin: 0,
  color: "#9cbcdf",
  fontSize: 14,
  lineHeight: 1.45,
  maxWidth: 76 * 8,
};

const heroActionsStyle = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
  marginTop: 12,
};

const intervalToggleStyle = {
  marginTop: 10,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 6,
};

const toggleButtonStyle = {
  border: "1px solid rgba(141, 188, 238, 0.58)",
  borderRadius: 999,
  background: "rgba(10, 30, 53, 0.78)",
  color: "#d7ecff",
  padding: "6px 10px",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const toggleActiveStyle = {
  ...toggleButtonStyle,
  border: "1px solid rgba(109, 188, 251, 0.82)",
  background: "linear-gradient(145deg, rgba(23, 93, 149, 0.88), rgba(17, 74, 125, 0.9))",
  color: "#ecf7ff",
};

const annualBadgeStyle = {
  borderRadius: 999,
  border: "1px solid rgba(112, 238, 194, 0.72)",
  background: "rgba(19, 86, 63, 0.52)",
  color: "#d8ffec",
  padding: "4px 8px",
  fontSize: 11,
  fontWeight: 700,
};

const solidButtonStyle = {
  border: "1px solid rgba(112, 238, 194, 0.72)",
  borderRadius: 10,
  background: "linear-gradient(145deg, rgba(20, 112, 80, 0.94), rgba(17, 89, 65, 0.92))",
  color: "#effff7",
  padding: "8px 12px",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const ghostButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid rgba(141, 188, 238, 0.62)",
  borderRadius: 10,
  background: "rgba(10, 30, 53, 0.78)",
  color: "#dceeff",
  padding: "8px 12px",
  textDecoration: "none",
  fontWeight: 700,
  fontSize: 13,
};

const metaStyle = {
  marginTop: 8,
  marginBottom: 0,
  color: "#9cbcdf",
  fontSize: 14,
};

const phoneLinkStyle = {
  color: "#9dffd8",
  textDecoration: "none",
  borderBottom: "1px dashed rgba(157, 255, 216, 0.62)",
};

const warningStyle = {
  marginTop: 8,
  marginBottom: 0,
  color: "#ffe5a3",
  fontWeight: 600,
};

const errorStyle = {
  marginTop: 8,
  marginBottom: 0,
  color: "#ffc7cf",
  fontWeight: 600,
};

const successStyle = {
  marginTop: 8,
  marginBottom: 0,
  color: "#9ff4c8",
  fontWeight: 700,
};

const planGridStyle = {
  maxWidth: 960,
  margin: "8px auto 0",
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const commerceStripStyle = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "8px 10px",
  borderRadius: 12,
  border: "1px solid rgba(136, 181, 228, 0.36)",
  background: "linear-gradient(165deg, rgba(10, 28, 51, 0.84), rgba(9, 24, 45, 0.88))",
  display: "grid",
  gap: 4,
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
};

const commerceStripTextStyle = {
  margin: 0,
  color: "#b4d0ec",
  fontWeight: 600,
  fontSize: 12,
};

const planCardStyle = (isCurrentPlan, isRecommended) => ({
  border: `1px solid ${isCurrentPlan ? "rgba(112, 238, 194, 0.72)" : isRecommended ? "rgba(109, 188, 251, 0.82)" : "rgba(136, 181, 228, 0.36)"}`,
  borderRadius: 16,
  padding: 12,
  background: "linear-gradient(165deg, rgba(8, 24, 47, 0.88), rgba(8, 21, 41, 0.92))",
  boxShadow: isRecommended ? "0 16px 28px rgba(36, 111, 185, 0.22)" : "0 12px 22px rgba(2, 9, 20, 0.34)",
});

const planHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
};

const planTitleStyle = {
  margin: 0,
  fontSize: "1.1rem",
};

const popularBadgeStyle = {
  borderRadius: 999,
  border: "1px solid #2f78c8",
  padding: "2px 7px",
  fontSize: 11,
  color: "#225f9e",
  fontWeight: 700,
  background: "#eaf4ff",
};

const planSubtitleStyle = {
  marginTop: 4,
  marginBottom: 6,
  fontWeight: 600,
  color: "#a5c4e4",
  fontSize: 14,
};

const priceStyle = {
  marginTop: 0,
  marginBottom: 6,
  fontSize: "1.4rem",
  fontWeight: 800,
  color: "#e8f5ff",
};

const savingsStyle = {
  marginTop: -2,
  marginBottom: 8,
  color: "#9ff4c8",
  fontWeight: 700,
  fontSize: 12,
};

const planDescriptionStyle = {
  marginTop: 0,
  marginBottom: 8,
  color: "#a5c4e4",
  fontSize: 14,
  lineHeight: 1.35,
};

const featureListStyle = {
  marginTop: 0,
  marginBottom: 10,
  paddingLeft: 18,
  color: "#cfe4fa",
  lineHeight: 1.3,
  fontSize: 14,
};

const checkoutButtonStyle = {
  width: "100%",
  border: "1px solid rgba(112, 238, 194, 0.72)",
  borderRadius: 10,
  background: "linear-gradient(145deg, rgba(20, 112, 80, 0.94), rgba(17, 89, 65, 0.92))",
  color: "#effff7",
  padding: "8px 10px",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
};

const currentPlanButtonStyle = {
  width: "100%",
  border: "1px solid rgba(138, 176, 220, 0.55)",
  borderRadius: 10,
  background: "rgba(14, 34, 59, 0.68)",
  color: "#b6d1ed",
  padding: "8px 10px",
  fontWeight: 700,
  fontSize: 13,
  cursor: "not-allowed",
};

const annualFallbackStyle = {
  marginTop: 8,
  marginBottom: 0,
  color: "#ffe5a3",
  fontSize: 12,
  fontWeight: 600,
};

const compactPageStyle = {
  ...pageStyle,
  padding: "10px min(2.1vw, 16px) 14px",
};

const compactHeroStyle = {
  ...heroStyle,
  margin: "0 auto 8px",
  padding: 12,
};

const compactTitleStyle = {
  ...titleStyle,
  marginTop: 6,
  marginBottom: 6,
  fontSize: "clamp(1.2rem, 2.1vw, 1.7rem)",
};

const compactSubtitleStyle = {
  ...subtitleStyle,
  fontSize: 12,
  lineHeight: 1.3,
};

const compactHeroActionsStyle = {
  ...heroActionsStyle,
  marginTop: 8,
  gap: 6,
};

const compactIntervalToggleStyle = {
  ...intervalToggleStyle,
  marginTop: 8,
  gap: 5,
};

const compactToggleButtonStyle = {
  ...toggleButtonStyle,
  padding: "5px 9px",
  fontSize: 12,
};

const compactToggleActiveStyle = {
  ...toggleActiveStyle,
  padding: "5px 9px",
  fontSize: 12,
};

const compactAnnualBadgeStyle = {
  ...annualBadgeStyle,
  padding: "3px 7px",
  fontSize: 10,
};

const compactGhostButtonStyle = {
  ...ghostButtonStyle,
  padding: "6px 10px",
  fontSize: 12,
};

const compactSolidButtonStyle = {
  ...solidButtonStyle,
  padding: "6px 10px",
  fontSize: 12,
};

const compactMetaStyle = {
  ...metaStyle,
  marginTop: 6,
  fontSize: 12,
};

const compactWarningStyle = {
  ...warningStyle,
  marginTop: 6,
  fontSize: 12,
};

const compactErrorStyle = {
  ...errorStyle,
  marginTop: 6,
  fontSize: 12,
};

const compactSuccessStyle = {
  ...successStyle,
  marginTop: 6,
  fontSize: 12,
};

const compactCommerceStripStyle = {
  ...commerceStripStyle,
  padding: "6px 8px",
  gap: 4,
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
};

const compactCommerceStripTextStyle = {
  ...commerceStripTextStyle,
  fontSize: 11,
};

const compactPlanGridStyle = {
  ...planGridStyle,
  margin: "6px auto 0",
  gap: 8,
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
};

const compactPlanGridThreeColumnStyle = {
  ...compactPlanGridStyle,
  gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
};

const compactPlanCardStyle = (isCurrentPlan, isRecommended) => ({
  ...planCardStyle(isCurrentPlan, isRecommended),
  padding: 9,
  borderRadius: 12,
  boxShadow: isRecommended
    ? "0 8px 14px rgba(47, 120, 200, 0.13)"
    : "0 5px 10px rgba(16, 38, 58, 0.05)",
});

const compactPlanTitleStyle = {
  ...planTitleStyle,
  fontSize: "0.98rem",
};

const compactPopularBadgeStyle = {
  ...popularBadgeStyle,
  fontSize: 10,
  padding: "2px 6px",
};

const compactPlanSubtitleStyle = {
  ...planSubtitleStyle,
  marginTop: 3,
  marginBottom: 4,
  fontSize: 12,
};

const compactPriceStyle = {
  ...priceStyle,
  marginBottom: 4,
  fontSize: "1.22rem",
};

const compactSavingsStyle = {
  ...savingsStyle,
  marginBottom: 4,
  fontSize: 11,
};

const compactPlanDescriptionStyle = {
  ...planDescriptionStyle,
  marginBottom: 5,
  fontSize: 12,
  lineHeight: 1.22,
};

const compactFeatureListStyle = {
  ...featureListStyle,
  marginBottom: 7,
  fontSize: 12,
  lineHeight: 1.2,
  paddingLeft: 16,
};

const compactCheckoutButtonStyle = {
  ...checkoutButtonStyle,
  padding: "6px 8px",
  fontSize: 12,
};

const compactCurrentPlanButtonStyle = {
  ...currentPlanButtonStyle,
  padding: "6px 8px",
  fontSize: 12,
};

const compactAnnualFallbackStyle = {
  ...annualFallbackStyle,
  marginTop: 6,
  fontSize: 11,
};

const tabletPageStyle = {
  ...pageStyle,
  padding: "14px min(2.8vw, 20px) 18px",
};

const tabletHeroStyle = {
  ...heroStyle,
  margin: "0 auto 10px",
  padding: 14,
  borderRadius: 14,
};

const tabletTitleStyle = {
  ...titleStyle,
  marginTop: 6,
  marginBottom: 6,
  fontSize: "clamp(1.35rem, 3.2vw, 1.9rem)",
};

const tabletSubtitleStyle = {
  ...subtitleStyle,
  fontSize: 13,
  lineHeight: 1.36,
};

const tabletHeroActionsStyle = {
  ...heroActionsStyle,
  marginTop: 10,
  gap: 7,
};

const tabletIntervalToggleStyle = {
  ...intervalToggleStyle,
  marginTop: 8,
  gap: 6,
};

const tabletToggleButtonStyle = {
  ...toggleButtonStyle,
  padding: "6px 10px",
  fontSize: 12,
};

const tabletToggleActiveStyle = {
  ...toggleActiveStyle,
  padding: "6px 10px",
  fontSize: 12,
};

const tabletAnnualBadgeStyle = {
  ...annualBadgeStyle,
  padding: "4px 8px",
  fontSize: 11,
};

const tabletGhostButtonStyle = {
  ...ghostButtonStyle,
  padding: "7px 10px",
  fontSize: 12,
};

const tabletSolidButtonStyle = {
  ...solidButtonStyle,
  padding: "7px 10px",
  fontSize: 12,
};

const tabletMetaStyle = {
  ...metaStyle,
  marginTop: 6,
  fontSize: 12,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const tabletWarningStyle = {
  ...warningStyle,
  marginTop: 6,
  fontSize: 12,
};

const tabletErrorStyle = {
  ...errorStyle,
  marginTop: 6,
  fontSize: 12,
};

const tabletSuccessStyle = {
  ...successStyle,
  marginTop: 6,
  fontSize: 12,
};

const tabletCommerceStripStyle = {
  ...commerceStripStyle,
  padding: "7px 8px",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 6,
};

const tabletCommerceStripTextStyle = {
  ...commerceStripTextStyle,
  fontSize: 11,
};

const tabletPlanGridStyle = {
  ...planGridStyle,
  margin: "8px auto 0",
  gap: 8,
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
};

const tabletPlanCardStyle = (isCurrentPlan, isRecommended) => ({
  ...planCardStyle(isCurrentPlan, isRecommended),
  padding: 10,
  borderRadius: 12,
});

const tabletPlanTitleStyle = {
  ...planTitleStyle,
  fontSize: "1.02rem",
};

const tabletPopularBadgeStyle = {
  ...popularBadgeStyle,
  fontSize: 10,
  padding: "2px 6px",
};

const tabletPlanSubtitleStyle = {
  ...planSubtitleStyle,
  marginTop: 3,
  marginBottom: 4,
  fontSize: 12,
};

const tabletPriceStyle = {
  ...priceStyle,
  marginBottom: 4,
  fontSize: "1.24rem",
};

const tabletSavingsStyle = {
  ...savingsStyle,
  marginBottom: 5,
  fontSize: 11,
};

const tabletPlanDescriptionStyle = {
  ...planDescriptionStyle,
  marginBottom: 6,
  fontSize: 12,
  lineHeight: 1.26,
};

const tabletFeatureListStyle = {
  ...featureListStyle,
  marginBottom: 8,
  fontSize: 12,
  lineHeight: 1.24,
};

const tabletCheckoutButtonStyle = {
  ...checkoutButtonStyle,
  padding: "7px 8px",
  fontSize: 12,
};

const tabletCurrentPlanButtonStyle = {
  ...currentPlanButtonStyle,
  padding: "7px 8px",
  fontSize: 12,
};

const tabletAnnualFallbackStyle = {
  ...annualFallbackStyle,
  marginTop: 6,
  fontSize: 11,
};

const mobilePageStyle = {
  ...pageStyle,
  padding: "12px 12px 16px",
};

const mobileHeroStyle = {
  ...heroStyle,
  margin: "0 auto 8px",
  padding: 12,
  borderRadius: 12,
};

const mobileTitleStyle = {
  ...titleStyle,
  marginTop: 5,
  marginBottom: 6,
  fontSize: "clamp(1.18rem, 7vw, 1.45rem)",
  lineHeight: 1.14,
};

const mobileSubtitleStyle = {
  ...subtitleStyle,
  fontSize: 12,
  lineHeight: 1.34,
};

const mobileHeroActionsStyle = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "1fr",
  gap: 6,
};

const mobileIntervalToggleStyle = {
  marginTop: 8,
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 6,
  alignItems: "center",
};

const mobileToggleButtonStyle = {
  ...toggleButtonStyle,
  width: "100%",
  textAlign: "center",
  padding: "7px 8px",
  fontSize: 12,
};

const mobileToggleActiveStyle = {
  ...toggleActiveStyle,
  width: "100%",
  textAlign: "center",
  padding: "7px 8px",
  fontSize: 12,
};

const mobileAnnualBadgeStyle = {
  ...annualBadgeStyle,
  gridColumn: "1 / -1",
  justifySelf: "start",
  padding: "4px 8px",
  fontSize: 10,
};

const mobileGhostButtonStyle = {
  ...ghostButtonStyle,
  width: "100%",
  justifyContent: "center",
  padding: "8px 10px",
  fontSize: 12,
};

const mobileSolidButtonStyle = {
  ...solidButtonStyle,
  width: "100%",
  justifyContent: "center",
  padding: "8px 10px",
  fontSize: 12,
};

const mobileMetaStyle = {
  ...metaStyle,
  marginTop: 6,
  fontSize: 12,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
};

const mobileWarningStyle = {
  ...warningStyle,
  marginTop: 6,
  fontSize: 12,
};

const mobileErrorStyle = {
  ...errorStyle,
  marginTop: 6,
  fontSize: 12,
};

const mobileSuccessStyle = {
  ...successStyle,
  marginTop: 6,
  fontSize: 12,
};

const mobileCommerceStripStyle = {
  ...commerceStripStyle,
  padding: "7px 8px",
  gridTemplateColumns: "1fr",
  gap: 6,
};

const mobileCommerceStripTextStyle = {
  ...commerceStripTextStyle,
  fontSize: 11,
};

const mobilePlanGridStyle = {
  ...planGridStyle,
  margin: "8px auto 0",
  gap: 8,
  gridTemplateColumns: "1fr",
};

const mobilePlanCardStyle = (isCurrentPlan, isRecommended) => ({
  ...planCardStyle(isCurrentPlan, isRecommended),
  padding: 10,
  borderRadius: 12,
});

const mobilePlanTitleStyle = {
  ...planTitleStyle,
  fontSize: "1rem",
};

const mobilePopularBadgeStyle = {
  ...popularBadgeStyle,
  fontSize: 10,
  padding: "2px 6px",
};

const mobilePlanSubtitleStyle = {
  ...planSubtitleStyle,
  marginTop: 2,
  marginBottom: 4,
  fontSize: 12,
};

const mobilePriceStyle = {
  ...priceStyle,
  marginBottom: 4,
  fontSize: "1.18rem",
};

const mobileSavingsStyle = {
  ...savingsStyle,
  marginBottom: 4,
  fontSize: 11,
};

const mobilePlanDescriptionStyle = {
  ...planDescriptionStyle,
  marginBottom: 6,
  fontSize: 12,
  lineHeight: 1.25,
};

const mobileFeatureListStyle = {
  ...featureListStyle,
  marginBottom: 8,
  fontSize: 12,
  lineHeight: 1.24,
  paddingLeft: 16,
};

const mobileCheckoutButtonStyle = {
  ...checkoutButtonStyle,
  padding: "8px 8px",
  fontSize: 12,
};

const mobileCurrentPlanButtonStyle = {
  ...currentPlanButtonStyle,
  padding: "8px 8px",
  fontSize: 12,
};

const mobileAnnualFallbackStyle = {
  ...annualFallbackStyle,
  marginTop: 6,
  fontSize: 11,
};
