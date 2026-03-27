import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import { AuthProvider } from "./auth/AuthContext";
import { initializeFirebaseAnalytics } from "./firebase";
import AppErrorBoundary from "./components/AppErrorBoundary";
import {
  clearModuleRecoveryMarker,
  isModuleLoadFailure,
  triggerModuleRecoveryReload,
} from "./lib/runtimeRecovery";
import "./index.css";

initializeFirebaseAnalytics();

if (typeof window !== "undefined") {
  clearModuleRecoveryMarker();

  window.addEventListener("error", (event) => {
    const candidate = event?.error ?? event?.message;
    if (!isModuleLoadFailure(candidate)) return;
    triggerModuleRecoveryReload("window_error");
  });

  window.addEventListener("unhandledrejection", (event) => {
    if (!isModuleLoadFailure(event?.reason)) return;
    event.preventDefault();
    triggerModuleRecoveryReload("unhandled_rejection");
  });
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <App />
        </AuthProvider>
      </BrowserRouter>
    </AppErrorBoundary>
  </React.StrictMode>
);
