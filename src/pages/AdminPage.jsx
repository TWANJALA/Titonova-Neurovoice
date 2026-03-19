import React from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function AdminPage() {
  const { roles, signOut } = useAuth();

  return (
    <div style={pageStyle}>
      <h1>Admin Console</h1>
      <p>This route only allows users with the admin role.</p>
      <p>Current roles: {roles.join(", ")}</p>

      <div style={{ display: "flex", gap: 10 }}>
        <Link to="/app">AAC workspace</Link>
        <Link to="/therapist">Therapist workspace</Link>
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
