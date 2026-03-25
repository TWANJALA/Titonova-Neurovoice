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
    <div style={containerStyle}>
      <h1>Create Parent Account</h1>
      <p style={{ marginTop: 0 }}>Therapist/admin roles are assigned by backend claims or profile updates.</p>
      {selectedPlan ? (
        <p style={{ marginTop: 0 }}>
          Selected plan: <strong>{selectedPlan.name}</strong> ({selectedPlan.priceLabel}). After signup, go to{" "}
          <Link to="/pricing">Pricing</Link> to complete checkout.
        </p>
      ) : null}

      <form onSubmit={handleSubmit} style={formStyle}>
        <label style={labelStyle}>
          Display name
          <input
            type="text"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          Email
          <input
            required
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            style={inputStyle}
          />
        </label>

        <label style={labelStyle}>
          Confirm password
          <input
            required
            type="password"
            value={confirmPassword}
            onChange={(event) => setConfirmPassword(event.target.value)}
            style={inputStyle}
          />
        </label>

        {error ? <p style={errorStyle}>{error}</p> : null}

        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Creating account..." : "Create account"}
        </button>
      </form>

      <p>
        Already have an account? <Link to="/login">Sign in</Link>
      </p>
    </div>
  );
}

const containerStyle = {
  maxWidth: 460,
  margin: "40px auto",
  padding: 24,
  border: "1px solid #ddd",
  borderRadius: 12,
};

const formStyle = {
  display: "grid",
  gap: 12,
  marginBottom: 12,
};

const labelStyle = {
  display: "grid",
  gap: 6,
  fontWeight: 600,
};

const inputStyle = {
  padding: 10,
  borderRadius: 8,
  border: "1px solid #ccc",
};

const buttonStyle = {
  padding: 10,
  border: "none",
  borderRadius: 8,
  cursor: "pointer",
};

const errorStyle = {
  margin: 0,
  color: "#9c1c1c",
};
