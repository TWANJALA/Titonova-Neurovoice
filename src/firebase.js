import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? "YOUR_API_KEY",
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? "YOUR_DOMAIN",
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? "YOUR_PROJECT_ID",
};

export const usingPlaceholderFirebaseConfig =
  firebaseConfig.apiKey === "YOUR_API_KEY" ||
  firebaseConfig.authDomain === "YOUR_DOMAIN" ||
  firebaseConfig.projectId === "YOUR_PROJECT_ID";

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
