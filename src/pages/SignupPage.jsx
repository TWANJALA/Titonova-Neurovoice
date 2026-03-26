import React, { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { normalizeAuthErrorCode, trackSignUpEvent } from "../lib/analyticsEvents";
import { getBillingPlan, isKnownPlanTier } from "../lib/billingPlans";

export default function SignupPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { loading, signUp, user, homePath, refreshAccess } = useAuth();
  const rawPlan = String(new URLSearchParams(location.search).get("plan") ?? "").trim().toLowerCase();
  const selectedPlan = isKnownPlanTier(rawPlan) ? getBillingPlan(rawPlan) : null;

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return <p style={{ padding: 24 }}>Loading access...</p>;
  }

  if (user) {
    return <Navigate to={homePath} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");

    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setSubmitting(true);

    try {
      await signUp({ displayName, email, password });
      let nextAccess = null;
      try {
        nextAccess = await refreshAccess();
      } catch (refreshError) {
        console.error("Access refresh after sign-up failed:", refreshError);
      }
      const destinationPath = nextAccess?.homePath ?? homePath;
      void trackSignUpEvent({
        outcome: "success",
        method: "password",
        role: nextAccess?.primaryRole ?? null,
        destinationPath,
        hasDisplayName: Boolean(displayName.trim()),
      });
      navigate(destinationPath, { replace: true });
    } catch (authError) {
      void trackSignUpEvent({
        outcome: "error",
        method: "password",
        hasDisplayName: Boolean(displayName.trim()),
        errorCode: normalizeAuthErrorCode(authError),
      });
      setError(authError.message || "Unable to create account.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="tn-auth-page">
      <section className="tn-card">
      <p className="tn-eyebrow">Titonova NeuroVoice</p>
      <h1 className="tn-title">Create Parent Account</h1>
      <p className="tn-subtitle">Therapist/admin roles are assigned by backend claims or profile updates.</p>
      {selectedPlan ? (
        <p className="tn-note" style={{ marginBottom: 12 }}>
          Selected plan: <strong>{selectedPlan.name}</strong> ({selectedPlan.priceLabel}). After signup, go to{" "}
          <Link to="/pricing">Pricing</Link> to complete checkout.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="tn-form">
        <label className="tn-label">
          Display name
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            className="tn-input"
          />
        </label>

        <label className="tn-label">
          Email
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="tn-input"
          />
        </label>

        <label className="tn-label">
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="tn-input"
          />
        </label>

        <label className="tn-label">
          Confirm password
          <input
            required
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            className="tn-input"
          />
        </label>

        {error ? <p className="tn-error">{error}</p> : null}

        <button type="submit" disabled={submitting} className="tn-btn tn-btn-primary">
          {submitting ? "Creating account..." : "Create account"}
        </button>
      </form>

      <p className="tn-note">
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
      </section>
    </main>
  );
}
