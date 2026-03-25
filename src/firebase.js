import { initializeApp } from "firebase/app";
import { getAnalytics, isSupported, logEvent } from "firebase/analytics";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "YOUR_API_KEY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "YOUR_DOMAIN",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "YOUR_PROJECT_ID",
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const usingPlaceholderFirebaseConfig =
  firebaseConfig.apiKey === "YOUR_API_KEY" ||
  firebaseConfig.authDomain === "YOUR_DOMAIN" ||
  firebaseConfig.projectId === "YOUR_PROJECT_ID";

const app = initializeApp(firebaseConfig);
let analyticsInitPromise = null;

export const auth = getAuth(app);
export const db = getFirestore(app);

export function initializeFirebaseAnalytics() {
  if (typeof window === "undefined") return Promise.resolve(null);
  if (!firebaseConfig.measurementId) return Promise.resolve(null);
  if (analyticsInitPromise) return analyticsInitPromise;

  analyticsInitPromise = isSupported()
    .then((supported) => {
      if (!supported) return null;
      return getAnalytics(app);
    })
    .catch((error) => {
      console.warn("Firebase Analytics initialization skipped:", error);
      return null;
    });

  return analyticsInitPromise;
}

export async function logAnalytics(name, params = {}) {
  const analytics = await initializeFirebaseAnalytics();
  if (!analytics) return false;
  logEvent(analytics, name, params);
  return true;
}

export function trackPageView(path) {
  if (typeof window === "undefined") return Promise.resolve(false);

  return logAnalytics("page_view", {
    page_path: path,
    page_location: window.location.href,
    page_title: document.title,
  });
}
