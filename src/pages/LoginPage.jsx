import React, { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { resolvePostAuthPath } from "../lib/authRouting";
import { normalizeAuthErrorCode, trackSignInEvent } from "../lib/analyticsEvents";

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { loading, signIn, user, roles, homePath, refreshAccess } = useAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const fromPath = location.state?.from?.pathname;

  if (loading) {
    return <p style={{ padding: 24 }}>Loading access...</p>;
  }

  if (user) {
    const redirectPath = resolvePostAuthPath({
      requestedPath: fromPath,
      userRoles: roles,
      fallbackPath: homePath,
    });
    return <Navigate to={redirectPath} replace />;
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSubmitting(true);

    try {
      await signIn({ email, password });
      let nextAccess = null;
      try {
        nextAccess = await refreshAccess();
      } catch (refreshError) {
        console.error("Access refresh after sign-in failed:", refreshError);
      }
      const redirectPath = resolvePostAuthPath({
        requestedPath: fromPath,
        userRoles: nextAccess?.roles ?? roles,
        fallbackPath: nextAccess?.homePath ?? homePath,
      });
      void trackSignInEvent({
        outcome: "success",
        method: "password",
        role: nextAccess?.primaryRole ?? roles?.[0] ?? null,
        destinationPath: redirectPath,
      });
      navigate(redirectPath, { replace: true });
    } catch (authError) {
      void trackSignInEvent({
        outcome: "error",
        method: "password",
        errorCode: normalizeAuthErrorCode(authError),
      });
      setError(authError.message || "Unable to sign in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="tn-auth-page">
      <section className="tn-card">
        <p className="tn-eyebrow">Titonova NeuroVoice</p>
        <h1 className="tn-title">Sign In</h1>
        <p className="tn-subtitle">Continue to your workspace, billing, and therapy dashboards.</p>
        <form onSubmit={handleSubmit} className="tn-form">
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

          {error ? <p className="tn-error">{error}</p> : null}

          <button type="submit" disabled={submitting} className="tn-btn tn-btn-primary">
            {submitting ? "Signing in..." : "Sign In"}
          </button>
        </form>

        <p className="tn-note">
          Need an account? <Link to="/signup">Create one</Link>
        </p>
      </section>
    </main>
  );
}
