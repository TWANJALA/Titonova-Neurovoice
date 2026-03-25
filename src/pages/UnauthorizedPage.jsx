import React from "react";
import { Link } from "react-router-dom";

export default function UnauthorizedPage() {
  return (
    <div style={{ maxWidth: 560, margin: "48px auto", padding: 24 }}>
      <h1>Access denied</h1>
      <p>Your account is authenticated, but it does not have the required role for this page.</p>
      <Link to="/dashboard">Return to dashboard</Link>
    </div>
  );
}
