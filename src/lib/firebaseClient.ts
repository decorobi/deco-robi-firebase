// src/lib/firebaseClient.ts
import { initializeApp } from 'firebase/app';
import { getFirestore, enableIndexedDbPersistence } from 'firebase/firestore';
import { getAuth, signInAnonymously, onAuthStateChanged } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID, // 👈 fix
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);

export const db = getFirestore(app);
export const auth = getAuth(app);

export async function ensureAnonAuth(): Promise<void> {
  return new Promise((resolve, reject) => {
    onAuthStateChanged(
      auth,
      async (user) => {
        try {
          if (!user) {
            await signInAnonymously(auth);
          }
          resolve();
        } catch (e) {
          console.error('signInAnonymously error', e);
          reject(e);
        }
      },
      (e) => {
        console.error('onAuthStateChanged error', e);
        reject(e);
      }
    );
  });
}

// cache offline (ignora l'errore se non disponibile)
enableIndexedDbPersistence(db).catch(() => {});
