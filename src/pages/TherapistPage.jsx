import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ROLES } from "../constants/roles";

export default function TherapistPage() {
  const { roles, signOut, hasAnyRole } = useAuth();

  return (
    <div style={pageStyle}>
      <h1>Therapist Workspace</h1>
      <p>Role-gated route confirmed. Build clinical tooling here next.</p>
      <p>Current roles: {roles.join(", ") || ROLES.THERAPIST}</p>

      <div style={{ display: "flex", gap: 10 }}>
        <Link to="/app">Go to AAC workspace</Link>
        {hasAnyRole([ROLES.ADMIN]) ? <Link to="/admin">Go to Admin</Link> : null}
        <button onClick={signOut} style={buttonStyle}>
          Sign out
        </button>
      </div>
    </div>
  );
}

const pageStyle = {
  maxWidth: 700,
  margin: "40px auto",
  padding: 24,
};

const buttonStyle = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid #ccc",
  cursor: "pointer",
};
