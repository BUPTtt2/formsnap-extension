import { ExtensionSettings, DEFAULT_SETTINGS, PopupState } from '../core/types';

const SETTINGS_KEY = 'formsnap_settings';
const POPUP_STATE_KEY = 'formsnap_popup_state';
const POPUP_IMAGES_KEY = 'formsnap_popup_images';
const MAX_IMAGES_TO_SAVE = 5;
const IDB_NAME = 'formsnap_idb';
const IDB_VERSION = 1;
const IDB_STORE = 'images';

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveImagesToIDB(images: string[]): Promise<void> {
  if (images.length === 0) return;
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);
    // Clear old images
    store.clear();
    const trimmed = images.slice(0, MAX_IMAGES_TO_SAVE);
    for (let i = 0; i < trimmed.length; i++) {
      store.put(trimmed[i], `img_${i}`);
    }
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // IndexedDB not available, fall back to storage (will fail silently if too large)
  }
}

async function loadImagesFromIDB(): Promise<string[]> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const store = tx.objectStore(IDB_STORE);
    const images: string[] = [];
    for (let i = 0; i < MAX_IMAGES_TO_SAVE; i++) {
      const result = await new Promise<string | undefined>((resolve) => {
        const req = store.get(`img_${i}`);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(undefined);
      });
      if (result) images.push(result);
    }
    db.close();
    return images;
  } catch {
    return [];
  }
}

async function clearImagesFromIDB(): Promise<void> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {}
}

export async function getSettings(): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      const saved = result[SETTINGS_KEY];
      if (saved) {
        resolve({ ...DEFAULT_SETTINGS, ...saved });
      } else {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  });
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SETTINGS_KEY, (result) => {
      const current = result[SETTINGS_KEY] ? { ...DEFAULT_SETTINGS, ...result[SETTINGS_KEY] } : { ...DEFAULT_SETTINGS };
      const updated = { ...current, ...settings };
      chrome.storage.local.set({ [SETTINGS_KEY]: updated }, () => {
        resolve(updated);
      });
    });
  });
}

export async function savePopupState(state: PopupState): Promise<void> {
  // Save images to IndexedDB (no size limit)
  await saveImagesToIDB(state.imagesBase64);
  // Save everything else (without images) to chrome.storage.local
  const stateToSave: PopupState = {
    ...state,
    imagesBase64: [], // Don't store in chrome.storage.local
    timestamp: Date.now(),
  };
  return new Promise((resolve) => {
    chrome.storage.local.set({ [POPUP_STATE_KEY]: stateToSave }, () => {
      resolve();
    });
  });
}

export async function getPopupState(): Promise<PopupState | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(POPUP_STATE_KEY, async (result) => {
      const state = result[POPUP_STATE_KEY] as PopupState | undefined;
      if (!state) {
        resolve(null);
        return;
      }
      // Discard state older than 30 minutes
      const THIRTY_MINUTES = 30 * 60 * 1000;
      if (Date.now() - state.timestamp > THIRTY_MINUTES) {
        chrome.storage.local.remove(POPUP_STATE_KEY);
        clearImagesFromIDB();
        resolve(null);
        return;
      }
      // Restore images from IndexedDB
      const images = await loadImagesFromIDB();
      state.imagesBase64 = images;
      resolve(state);
    });
  });
}

export async function clearPopupState(): Promise<void> {
  await clearImagesFromIDB();
  return new Promise((resolve) => {
    chrome.storage.local.remove(POPUP_STATE_KEY, () => {
      resolve();
    });
  });
}
