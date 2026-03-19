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

const AuthContext = createContext(null);

async function buildAccessState(user) {
  if (!user) {
    return {
      user: null,
      profile: null,
      roles: [],
      primaryRole: null,
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

  const claimRoles = normalizeRoles(tokenResult.claims.roles ?? tokenResult.claims.role);
  const profileRoles = normalizeRoles(profile?.roles ?? profile?.role);
  const mergedRoles = [...new Set([...claimRoles, ...profileRoles])];

  return {
    user,
    profile,
    roles: mergedRoles,
    primaryRole: mergedRoles[0] ?? null,
  };
}

export function AuthProvider({ children }) {
  const [state, setState] = useState({
    loading: true,
    user: null,
    profile: null,
    roles: [],
    primaryRole: null,
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
            createdAt: serverTimestamp(),
          },
          { merge: true }
        );

        return credential.user;
      },
      signOut: async () => {
        await signOut(auth);
      },
      refreshAccess: async () => {
        const currentUser = auth.currentUser;
        if (!currentUser) return;

        const nextAccess = await buildAccessState(currentUser);
        setState({ loading: false, error: null, ...nextAccess });
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
