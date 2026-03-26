import React from "react";
import { Link } from "react-router-dom";

export default function UnauthorizedPage() {
  return (
    <main className="tn-auth-page">
      <section className="tn-card">
        <p className="tn-eyebrow">Access Control</p>
        <h1 className="tn-title">Access denied</h1>
        <p className="tn-subtitle">
          Your account is authenticated, but it does not have the required role for this page.
        </p>
        <div className="tn-row">
          <Link to="/dashboard" className="tn-btn tn-btn-primary">
            Return to dashboard
          </Link>
          <Link to="/pricing" className="tn-btn tn-btn-ghost">
            View plans
          </Link>
        </div>
      </section>
    </main>
  );
}
