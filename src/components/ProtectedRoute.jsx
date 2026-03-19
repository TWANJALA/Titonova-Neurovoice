import React from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

export default function ProtectedRoute({ allowedRoles = [] }) {
  const location = useLocation();
  const { loading, user, hasAnyRole } = useAuth();

  if (loading) {
    return <p style={{ padding: 24 }}>Loading access...</p>;
  }

  if (!user) {
    return <Navigate to="/app" replace state={{ from: location }} />;
  }

  if (allowedRoles.length > 0 && !hasAnyRole(allowedRoles)) {
    return <Navigate to="/unauthorized" replace />;
  }

  return <Outlet />;
}
