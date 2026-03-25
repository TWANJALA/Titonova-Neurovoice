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
    <div style={containerStyle}>
      <h1>Sign In</h1>
      <form onSubmit={handleSubmit} style={formStyle}>
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

        {error ? <p style={errorStyle}>{error}</p> : null}

        <button type="submit" disabled={submitting} style={buttonStyle}>
          {submitting ? "Signing in..." : "Sign In"}
        </button>
      </form>

      <p>
        Need an account? <Link to="/signup">Create one</Link>
      </p>
    </div>
  );
}

const containerStyle = {
  maxWidth: 420,
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
