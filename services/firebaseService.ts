import { FirebaseApp, getApps, initializeApp } from 'firebase/app';
import { Auth, getAuth, onAuthStateChanged, signInAnonymously } from 'firebase/auth';

// Normalize the storage bucket value so the Firebase SDK always gets a
// valid bucket name regardless of whether Cloud console surfaced the
// download host or the raw bucket name.
const normalizeStorageBucket = (bucket: string | undefined, projectId: string | undefined) => {
  const trimmed = bucket?.trim();
  if (trimmed) return trimmed;
  return projectId ? `${projectId}.appspot.com` : '';
};

// Firebase configuration from runtime config or build-time env vars.
// Runtime config is the Cloud Run path — docker-entrypoint.sh writes
// window.__RUNTIME_CONFIG__ before the app boots. Local dev falls back
// to VITE_FIREBASE_* env vars.
const getFirebaseConfig = () => {
  const runtimeConfig = typeof window !== 'undefined' ? (window as any).__RUNTIME_CONFIG__ : undefined;

  if (runtimeConfig) {
    const projectId = runtimeConfig.FIREBASE_PROJECT_ID || '';
    return {
      apiKey: runtimeConfig.FIREBASE_API_KEY || '',
      authDomain: runtimeConfig.FIREBASE_AUTH_DOMAIN || '',
      projectId,
      storageBucket: normalizeStorageBucket(runtimeConfig.FIREBASE_STORAGE_BUCKET, projectId),
      messagingSenderId: runtimeConfig.FIREBASE_MESSAGING_SENDER_ID || '',
      appId: runtimeConfig.FIREBASE_APP_ID || '',
    };
  }

  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID || '';
  return {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || '',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId,
    storageBucket: normalizeStorageBucket(import.meta.env.VITE_FIREBASE_STORAGE_BUCKET, projectId),
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID || '',
  };
};

const logMissingConfig = (config: ReturnType<typeof getFirebaseConfig>, requireBucket: boolean) => {
  const missing: string[] = [];
  if (!config.apiKey) missing.push('FIREBASE_API_KEY');
  if (!config.projectId) missing.push('FIREBASE_PROJECT_ID');
  if (requireBucket && !config.storageBucket) missing.push('FIREBASE_STORAGE_BUCKET');
  if (missing.length > 0) {
    console.warn(`Firebase config missing: ${missing.join(', ')}`);
  }
};

const hasAppCredentials = (): boolean => {
  const config = getFirebaseConfig();
  const configured = !!(config.apiKey && config.projectId);
  if (!configured) logMissingConfig(config, false);
  return configured;
};

export const isFirestoreConfigured = (): boolean => hasAppCredentials();

export const isStorageConfigured = (): boolean => {
  const config = getFirebaseConfig();
  const configured = !!(config.apiKey && config.projectId && config.storageBucket);
  if (!configured) logMissingConfig(config, true);
  return configured;
};

let firebaseApp: FirebaseApp | null = null;
let firebaseAuth: Auth | null = null;
let authReady: Promise<Auth | null> | null = null;

const getOrInitializeApp = (): FirebaseApp | null => {
  if (!hasAppCredentials()) {
    console.log('Firebase not configured');
    return null;
  }

  if (!firebaseApp) {
    const existing = getApps();
    firebaseApp = existing[0] ?? initializeApp(getFirebaseConfig());
  }

  return firebaseApp;
};

export const getFirebaseApp = (): FirebaseApp | null => getOrInitializeApp();

// Bootstrap the app and wait for anonymous auth to resolve. Security rules
// require request.auth != null for both Firestore reads and Storage reads,
// so every query path goes through this.
export const getFirebaseAppWithAuth = async (): Promise<FirebaseApp | null> => {
  if (!hasAppCredentials()) {
    logMissingConfig(getFirebaseConfig(), false);
    return null;
  }

  const app = getOrInitializeApp();
  if (!app) return null;

  if (!authReady) {
    authReady = new Promise<Auth | null>((resolve) => {
      firebaseAuth = getAuth(app);

      if (firebaseAuth.currentUser) {
        resolve(firebaseAuth);
        return;
      }

      const unsubscribe = onAuthStateChanged(firebaseAuth, (user) => {
        if (user) {
          unsubscribe();
          resolve(firebaseAuth);
        }
      });

      signInAnonymously(firebaseAuth).catch((error) => {
        console.warn('Anonymous Firebase auth failed:', error);
        unsubscribe();
        resolve(null);
      });
    });
  }

  await authReady;
  return app;
};
