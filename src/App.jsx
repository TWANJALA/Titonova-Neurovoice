import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import ProtectedRoute from "./components/ProtectedRoute";
import { ROLES } from "./constants/roles";
import AdminPage from "./pages/AdminPage";
import LandingPage from "./pages/LandingPage";
import ParentPage from "./pages/ParentPage";
import TherapistPage from "./pages/TherapistPage";
import UnauthorizedPage from "./pages/UnauthorizedPage";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/login" element={<Navigate to="/app" replace />} />
      <Route path="/signup" element={<Navigate to="/app" replace />} />
      <Route path="/unauthorized" element={<UnauthorizedPage />} />
      <Route path="/app" element={<ParentPage />} />

      <Route element={<ProtectedRoute allowedRoles={[ROLES.THERAPIST, ROLES.ADMIN]} />}>
        <Route path="/therapist" element={<TherapistPage />} />
      </Route>

      <Route element={<ProtectedRoute allowedRoles={[ROLES.ADMIN]} />}>
        <Route path="/admin" element={<AdminPage />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
