import React, { useEffect, useMemo, useState } from "react";
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

export default function PricingPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    loading,
    user,
    planTier,
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
  const annualBadgeText = "Annual billing usually reduces total cost.";

  return (
    <main style={pageStyle}>
      <section style={heroStyle}>
        <p style={eyebrowStyle}>Billing</p>
        <h1 style={titleStyle}>Choose your Titonova NeuroVoice plan</h1>
        <p style={subtitleStyle}>
          Global checkout with tax/VAT capture, annual billing support, and plans optimized for households and therapy teams.
        </p>
        <div style={heroActionsStyle}>
          <Link to="/app" style={ghostButtonStyle}>
            Back to workspace
          </Link>
          {user && stripeCustomerId ? (
            <button
              type="button"
              onClick={handleOpenPortal}
              disabled={isBusy("portal")}
              style={solidButtonStyle}
            >
              {isBusy("portal") ? "Opening portal..." : "Manage Billing"}
            </button>
          ) : null}
          <a
            href="mailto:sales@titonova.com?subject=Titonova%20NeuroVoice%20Global%20Plan%20Inquiry"
            style={ghostButtonStyle}
          >
            Contact Sales
          </a>
        </div>
        <div style={intervalToggleStyle}>
          <button
            type="button"
            onClick={() => setBillingInterval(BILLING_INTERVALS.MONTH)}
            disabled={busyKey !== ""}
            style={billingInterval === BILLING_INTERVALS.MONTH ? toggleActiveStyle : toggleButtonStyle}
          >
            Monthly
          </button>
          <button
            type="button"
            onClick={() => setBillingInterval(BILLING_INTERVALS.YEAR)}
            disabled={busyKey !== ""}
            style={billingInterval === BILLING_INTERVALS.YEAR ? toggleActiveStyle : toggleButtonStyle}
          >
            Yearly
          </button>
          {isAnnual ? <span style={annualBadgeStyle}>{annualBadgeText}</span> : null}
        </div>
        <p style={metaStyle}>
          Current plan: <strong>{formatTierName(planTier)}</strong>
        </p>
        {loading ? <p style={metaStyle}>Loading account...</p> : null}
        {checkoutStatus === "cancel" ? <p style={warningStyle}>Checkout canceled. No changes were made.</p> : null}
        {error ? <p style={errorStyle}>{error}</p> : null}
        {message ? <p style={successStyle}>{message}</p> : null}
      </section>

      <section style={commerceStripStyle}>
        <p style={commerceStripTextStyle}>Global card-ready checkout</p>
        <p style={commerceStripTextStyle}>Tax/VAT information captured during purchase</p>
        <p style={commerceStripTextStyle}>Promotion codes and billing portal enabled</p>
      </section>

      <section style={planGridStyle}>
        {BILLING_PLAN_ORDER.map((plan) => {
          const isCurrentPlan = plan.tier === planTier;
          const planIntervalSupport =
            billingHealth?.plansConfigured?.[plan.tier] ?? {};
          const isIntervalReady =
            billingInterval === BILLING_INTERVALS.YEAR
              ? Boolean(planIntervalSupport?.year)
              : Boolean(planIntervalSupport?.month ?? true);
          const checkoutKey = `${plan.tier}:${billingInterval}`;
          const isPlanBusy = isBusy(checkoutKey);

          return (
            <article key={plan.tier} style={planCardStyle(isCurrentPlan, plan.recommended)}>
              <div style={planHeaderStyle}>
                <h2 style={planTitleStyle}>{plan.name}</h2>
                {plan.recommended ? <span style={popularBadgeStyle}>Most Popular</span> : null}
              </div>
              <p style={planSubtitleStyle}>{plan.subtitle}</p>
              <p style={priceStyle}>{getPlanPriceLabel(plan.tier, billingInterval)}</p>
              {isAnnual ? <p style={savingsStyle}>{plan.yearlySavingsLabel}</p> : null}
              <p style={planDescriptionStyle}>{plan.description}</p>
              <ul style={featureListStyle}>
                {plan.highlights.map((item) => (
                  <li key={`${plan.tier}-${item}`}>{item}</li>
                ))}
              </ul>
              <button
                type="button"
                onClick={() => handleCheckout(plan.tier, billingInterval)}
                disabled={isCurrentPlan || busyKey !== "" || !isIntervalReady}
                style={isCurrentPlan ? currentPlanButtonStyle : checkoutButtonStyle}
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
                <p style={annualFallbackStyle}>
                  Annual billing for this tier is not configured yet. Use monthly now or contact sales.
                </p>
              ) : null}
            </article>
          );
        })}
      </section>
    </main>
  );
}

const pageStyle = {
  minHeight: "100vh",
  padding: "28px min(4vw, 36px) 42px",
  background:
    "radial-gradient(900px 400px at 5% -5%, #c8ecff 0%, transparent 60%), radial-gradient(700px 380px at 100% 0%, #d8ffe5 0%, transparent 65%), linear-gradient(170deg, #f4f9ff, #eef6ff)",
  color: "#10263a",
};

const heroStyle = {
  maxWidth: 960,
  margin: "0 auto 18px",
  padding: 24,
  borderRadius: 18,
  border: "1px solid #bfd9ef",
  background: "linear-gradient(180deg, #ffffff, #f5fbff)",
  boxShadow: "0 12px 26px rgba(16, 38, 58, 0.08)",
};

const eyebrowStyle = {
  margin: 0,
  textTransform: "uppercase",
  letterSpacing: "0.12em",
  fontSize: 12,
  color: "#24619a",
  fontWeight: 700,
};

const titleStyle = {
  marginTop: 10,
  marginBottom: 10,
  lineHeight: 1.08,
  fontSize: "clamp(1.8rem, 4vw, 2.7rem)",
};

const subtitleStyle = {
  margin: 0,
  color: "#48637c",
  maxWidth: 76 * 8,
};

const heroActionsStyle = {
  display: "flex",
  gap: 10,
  flexWrap: "wrap",
  marginTop: 16,
};

const intervalToggleStyle = {
  marginTop: 14,
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 8,
};

const toggleButtonStyle = {
  border: "1px solid #94b5d4",
  borderRadius: 999,
  background: "#f8fbff",
  color: "#2e4b67",
  padding: "7px 12px",
  fontWeight: 700,
  cursor: "pointer",
};

const toggleActiveStyle = {
  ...toggleButtonStyle,
  border: "1px solid #2f78c8",
  background: "#eaf4ff",
  color: "#1a4f86",
};

const annualBadgeStyle = {
  borderRadius: 999,
  border: "1px solid #2f9f6f",
  background: "#ebf9f1",
  color: "#146640",
  padding: "5px 9px",
  fontSize: 12,
  fontWeight: 700,
};

const solidButtonStyle = {
  border: "1px solid #1f8a5e",
  borderRadius: 10,
  background: "#27a86f",
  color: "#fff",
  padding: "10px 14px",
  fontWeight: 700,
  cursor: "pointer",
};

const ghostButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid #9bb7cf",
  borderRadius: 10,
  background: "#fff",
  color: "#153754",
  padding: "10px 14px",
  textDecoration: "none",
  fontWeight: 700,
};

const metaStyle = {
  marginTop: 12,
  marginBottom: 0,
  color: "#33516c",
};

const warningStyle = {
  marginTop: 12,
  marginBottom: 0,
  color: "#8b5500",
  fontWeight: 600,
};

const errorStyle = {
  marginTop: 12,
  marginBottom: 0,
  color: "#9d1e1e",
  fontWeight: 600,
};

const successStyle = {
  marginTop: 12,
  marginBottom: 0,
  color: "#0f7a42",
  fontWeight: 700,
};

const planGridStyle = {
  maxWidth: 960,
  margin: "12px auto 0",
  display: "grid",
  gap: 14,
  gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))",
};

const commerceStripStyle = {
  maxWidth: 960,
  margin: "0 auto",
  padding: "10px 14px",
  borderRadius: 12,
  border: "1px solid #c8dcf0",
  background: "linear-gradient(180deg, #f8fbff, #f1f8ff)",
  display: "grid",
  gap: 6,
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const commerceStripTextStyle = {
  margin: 0,
  color: "#33516c",
  fontWeight: 600,
  fontSize: 13,
};

const planCardStyle = (isCurrentPlan, isRecommended) => ({
  border: `1px solid ${isCurrentPlan ? "#2f9f6f" : isRecommended ? "#2f78c8" : "#bfd4e8"}`,
  borderRadius: 16,
  padding: 16,
  background: "linear-gradient(180deg, #ffffff, #f6fbff)",
  boxShadow: isRecommended ? "0 16px 28px rgba(47, 120, 200, 0.16)" : "0 10px 20px rgba(16, 38, 58, 0.06)",
});

const planHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 8,
};

const planTitleStyle = {
  margin: 0,
  fontSize: "1.25rem",
};

const popularBadgeStyle = {
  borderRadius: 999,
  border: "1px solid #2f78c8",
  padding: "3px 8px",
  fontSize: 12,
  color: "#225f9e",
  fontWeight: 700,
  background: "#eaf4ff",
};

const planSubtitleStyle = {
  marginTop: 6,
  marginBottom: 8,
  fontWeight: 600,
  color: "#49637d",
};

const priceStyle = {
  marginTop: 0,
  marginBottom: 10,
  fontSize: "1.55rem",
  fontWeight: 800,
  color: "#143351",
};

const savingsStyle = {
  marginTop: -6,
  marginBottom: 10,
  color: "#1c7a4f",
  fontWeight: 700,
  fontSize: 13,
};

const planDescriptionStyle = {
  marginTop: 0,
  marginBottom: 10,
  color: "#4a647d",
  minHeight: 44,
};

const featureListStyle = {
  marginTop: 0,
  marginBottom: 14,
  paddingLeft: 18,
  color: "#1d3f60",
  lineHeight: 1.45,
  minHeight: 128,
};

const checkoutButtonStyle = {
  width: "100%",
  border: "1px solid #1f8a5e",
  borderRadius: 10,
  background: "#27a86f",
  color: "#fff",
  padding: "10px 12px",
  fontWeight: 700,
  cursor: "pointer",
};

const currentPlanButtonStyle = {
  width: "100%",
  border: "1px solid #9bbad4",
  borderRadius: 10,
  background: "#eff5fb",
  color: "#4b6881",
  padding: "10px 12px",
  fontWeight: 700,
  cursor: "not-allowed",
};

const annualFallbackStyle = {
  marginTop: 8,
  marginBottom: 0,
  color: "#6e4e00",
  fontSize: 12,
  fontWeight: 600,
};
