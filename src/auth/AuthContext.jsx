import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import {
  createUserWithEmailAndPassword,
  getIdTokenResult,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { auth, db } from "../firebase";
import { ROLES, hasAnyRole, normalizeRoles } from "../constants/roles";
import { trackSignOutEvent } from "../lib/analyticsEvents";
import { resolveHomePath } from "../lib/authRouting";
import {
  createCheckoutSession,
  createPortalSession,
  getSubscriptionStatus,
} from "../lib/billingClient";
import {
  BILLING_FEATURES,
  BILLING_INTERVALS,
  BILLING_TIERS,
  getPlanLimit,
  normalizeBillingInterval,
  normalizePlanTier,
  planHasFeature,
} from "../lib/billingPlans";

const AuthContext = createContext(null);

async function buildAccessState(user) {
  if (!user) {
    return {
      user: null,
      profile: null,
      roles: [],
      primaryRole: null,
      homePath: resolveHomePath([]),
      planTier: BILLING_TIERS.BASIC,
      subscriptionStatus: "guest",
      stripeCustomerId: "",
    };
  }

  const tokenResult = await getIdTokenResult(user);

  let profile = null;
  try {
    const userRef = doc(db, "users", user.uid);
    const profileSnapshot = await getDoc(userRef);
    profile = profileSnapshot.exists() ? profileSnapshot.data() : null;
  } catch (error) {
    console.error("Failed to fetch profile data:", error);
  }

  let serverBilling = null;
  try {
    const serverStatus = await getSubscriptionStatus();
    if (serverStatus?.billing && typeof serverStatus.billing === "object") {
      serverBilling = serverStatus.billing;
    }
  } catch {
    // Billing status falls back to Firestore profile/claims when billing API is unavailable.
  }

  const mergedProfile = serverBilling
    ? {
        ...(profile ?? {}),
        billing: {
          ...(profile?.billing ?? {}),
          ...serverBilling,
        },
      }
    : profile;

  const claimRoles = normalizeRoles(tokenResult.claims.roles ?? tokenResult.claims.role);
  const profileRoles = normalizeRoles(mergedProfile?.roles ?? mergedProfile?.role);
  const mergedRoles = [...new Set([...claimRoles, ...profileRoles])];
  const claimPlanTier = tokenResult.claims.planTier ?? tokenResult.claims.plan ?? tokenResult.claims.subscriptionTier;
  const profilePlanTier =
    mergedProfile?.billing?.tier ?? mergedProfile?.subscription?.tier ?? mergedProfile?.planTier;
  const planTier = normalizePlanTier(profilePlanTier || claimPlanTier, BILLING_TIERS.BASIC);
  const subscriptionStatus = String(
    mergedProfile?.billing?.status ?? tokenResult.claims.subscriptionStatus ?? "inactive"
  )
    .trim()
    .toLowerCase();
  const stripeCustomerId = String(
    mergedProfile?.billing?.stripeCustomerId ?? tokenResult.claims.stripeCustomerId ?? ""
  ).trim();

  return {
    user,
    profile: mergedProfile,
    roles: mergedRoles,
    primaryRole: mergedRoles[0] ?? null,
    homePath: resolveHomePath(mergedRoles),
    planTier,
    subscriptionStatus: subscriptionStatus || "inactive",
    stripeCustomerId,
  };
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({
    loading: true,
    user: null,
    profile: null,
    roles: [],
    primaryRole: null,
    homePath: resolveHomePath([]),
    planTier: BILLING_TIERS.BASIC,
    subscriptionStatus: "guest",
    stripeCustomerId: "",
    error: null,
  });

  useEffect(() => {
    let active = true;

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (!active) return;

      setState((prev) => ({ ...prev, loading: true, error: null }));

      try {
        const nextAccess = await buildAccessState(currentUser);
        if (!active) return;
        setState({ loading: false, error: null, ...nextAccess });
      } catch (error) {
        if (!active) return;
        setState({
          loading: false,
          user: currentUser,
          profile: null,
          roles: [],
          primaryRole: null,
          homePath: resolveHomePath([]),
          planTier: BILLING_TIERS.BASIC,
          subscriptionStatus: "inactive",
          stripeCustomerId: "",
          error,
        });
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      isAuthenticated: Boolean(state.user),
      hasAnyRole: (requiredRoles) => hasAnyRole(state.roles, requiredRoles),
      signIn: async ({ email, password }) => {
        const credential = await signInWithEmailAndPassword(auth, email, password);
        return credential.user;
      },
      signUp: async ({ displayName, email, password }) => {
        const credential = await createUserWithEmailAndPassword(auth, email, password);

        if (displayName?.trim()) {
          await updateProfile(credential.user, { displayName: displayName.trim() });
        }

        await setDoc(
          doc(db, "users", credential.user.uid),
          {
            email,
            displayName: displayName?.trim() ?? "",
            role: ROLES.PARENT,
            roles: [ROLES.PARENT],
            billing: {
              tier: BILLING_TIERS.BASIC,
              status: "inactive",
              updatedAt: serverTimestamp(),
            },
            createdAt: serverTimestamp(),
          },
          { merge: true }
        );

        return credential.user;
      },
      signOut: async () => {
        void trackSignOutEvent({
          role: state.primaryRole,
          currentPath: typeof window === "undefined" ? "" : window.location.pathname,
        });
        await signOut(auth);
      },
      hasFeature: (featureKey) => planHasFeature(state.planTier, featureKey),
      getPlanLimit: (limitKey) => getPlanLimit(state.planTier, limitKey),
      startCheckout: async ({
        tier = BILLING_TIERS.PRO,
        interval = BILLING_INTERVALS.MONTH,
        successPath = "",
        cancelPath = "",
      } = {}) => {
        if (!state.user) {
          throw new Error("Sign in is required before starting checkout.");
        }

        const normalizedTier = normalizePlanTier(tier, BILLING_TIERS.PRO);
        const normalizedInterval = normalizeBillingInterval(interval, BILLING_INTERVALS.MONTH);
        const origin = typeof window === "undefined" ? "" : window.location.origin;
        const toAbsoluteUrl = (path, fallbackPath) => {
          const raw = String(path ?? "").trim();
          if (!raw) return `${origin}${fallbackPath}`;
          if (/^https?:\/\//i.test(raw)) return raw;
          return `${origin}${raw.startsWith("/") ? raw : `/${raw}`}`;
        };

        return createCheckoutSession({
          tier: normalizedTier,
          interval: normalizedInterval,
          successUrl: toAbsoluteUrl(
            successPath,
            `/pricing?checkout=success&tier=${normalizedTier}&interval=${normalizedInterval}&session_id={CHECKOUT_SESSION_ID}`
          ),
          cancelUrl: toAbsoluteUrl(
            cancelPath,
            `/pricing?checkout=cancel&tier=${normalizedTier}&interval=${normalizedInterval}`
          ),
        });
      },
      openBillingPortal: async ({ returnPath = "/pricing" } = {}) => {
        if (!state.user) {
          throw new Error("Sign in is required before opening billing portal.");
        }

        const origin = typeof window === "undefined" ? "" : window.location.origin;
        const returnUrl = /^https?:\/\//i.test(String(returnPath ?? ""))
          ? String(returnPath)
          : `${origin}${String(returnPath).startsWith("/") ? returnPath : `/${returnPath}`}`;

        return createPortalSession({
          returnUrl,
        });
      },
      billingFeatures: BILLING_FEATURES,
      refreshAccess: async () => {
        const currentUser = auth.currentUser;
        if (!currentUser) return null;

        const nextAccess = await buildAccessState(currentUser);
        setState({ loading: false, error: null, ...nextAccess });
        return nextAccess;
      },
    }),
    [state]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }

  return context;
}
