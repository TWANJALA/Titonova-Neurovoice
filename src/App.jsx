import React, { Suspense, lazy } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth/AuthContext";
import AnalyticsRouteTracker from "./components/AnalyticsRouteTracker";
import ProtectedRoute from "./components/ProtectedRoute";
import { ROLES } from "./constants/roles";
import LandingPage from "./pages/LandingPage";
import LoginPage from "./pages/LoginPage";
import ParentPage from "./pages/ParentPage";
import SignupPage from "./pages/SignupPage";
import UnauthorizedPage from "./pages/UnauthorizedPage";

const TherapistPage = lazy(() => import("./pages/TherapistPage"));
const AdminPage = lazy(() => import("./pages/AdminPage"));
const McoDashboard = lazy(() => import("./pages/McoDashboard"));
const PricingPage = lazy(() => import("./pages/PricingPage"));

function HomeRoute() {
  const { loading, isAuthenticated, homePath } = useAuth();

  if (loading) {
    return <p style={{ padding: 24 }}>Loading access...</p>;
  }

  if (!isAuthenticated) {
    return <LandingPage />;
  }

  return <Navigate to={homePath} replace />;
}

function DashboardRoute() {
  const { loading, isAuthenticated, homePath } = useAuth();

  if (loading) {
    return <p style={{ padding: 24 }}>Loading access...</p>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  return <Navigate to={homePath} replace />;
}

export default function App() {
  return (
    <>
      <AnalyticsRouteTracker />
      <Suspense fallback={<p style={{ padding: 24 }}>Loading page...</p>}>
        <Routes>
          <Route path="/" element={<HomeRoute />} />
          <Route path="/dashboard" element={<DashboardRoute />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/pricing" element={<PricingPage />} />
          <Route path="/unauthorized" element={<UnauthorizedPage />} />
          <Route path="/app" element={<ParentPage />} />

          <Route element={<ProtectedRoute allowedRoles={[ROLES.THERAPIST, ROLES.ADMIN, ROLES.SUPER_ADMIN]} />}>
            <Route path="/therapist" element={<TherapistPage />} />
          </Route>

          <Route element={<ProtectedRoute allowedRoles={[ROLES.ADMIN, ROLES.SUPER_ADMIN]} />}>
            <Route path="/admin" element={<AdminPage />} />
            <Route path="/mco" element={<McoDashboard />} />
          </Route>

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </>
  );
}
