// src/lib/firebaseClient.ts
import { initializeApp } from 'firebase/app';
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

// Firestore
export const db = getFirestore(app);

// Auth
const auth = getAuth(app);

// Login anonimo: chiamato all’avvio dell’app
export async function ensureAnonAuth(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      async (user) => {
        try {
          if (!user) await signInAnonymously(auth);
          unsub(); // chiude il listener
          resolve();
        } catch (e) {
          unsub();
          reject(e);
        }
      },
      (e) => {
        unsub();
        reject(e);
      }
    );
  });
}

// Cache offline (se disponibile, ignora errori)
enableIndexedDbPersistence(db).catch(() => {});
