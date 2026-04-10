import { FirebaseStorage, getDownloadURL, getStorage, ref } from 'firebase/storage';

import { getFirebaseAppWithAuth, isStorageConfigured } from './firebaseService';

let storage: FirebaseStorage | null = null;

const initializeFirebaseStorage = async (): Promise<FirebaseStorage | null> => {
  if (!isStorageConfigured()) {
    console.log('Firebase storage not configured');
    return null;
  }

  if (!storage) {
    const app = await getFirebaseAppWithAuth();
    if (!app) return null;
    storage = getStorage(app);
  }

  return storage;
};

// Resolve a Firestore `storagePath` value to a time-limited download URL
// signed by the anonymous user. Used by the preview iframe and the
// download button.
export const resolveStorageDownloadURL = async (storagePath: string): Promise<string | null> => {
  const storageInstance = await initializeFirebaseStorage();
  if (!storageInstance) return null;

  try {
    const fileRef = ref(storageInstance, storagePath);
    return await getDownloadURL(fileRef);
  } catch (error) {
    console.error(`Failed to resolve download URL for "${storagePath}":`, error);
    return null;
  }
};
