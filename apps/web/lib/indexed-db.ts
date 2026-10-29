/**
 * Local-First IndexedDB Cache for Menu Items, Categories, and Modifiers.
 * Guarantees instantaneous, zero-network POS catalog lookups mid-shift
 * and ultra-low egress via timestamped delta synchronizations.
 */

export interface CachedCategory {
  id: string;
  name: string;
  description?: string | null;
  sortOrder: number;
  isActive: boolean;
  itemCount?: number;
}

export interface CachedMenuItem {
  id: string;
  categoryId: string;
  stationId?: string | null;
  name: string;
  price: string | number;
  halfPrice?: string | number | null;
  taxRatePercent: string | number;
  isVeg: boolean;
  isActive: boolean;
  imageUrl?: string | null;
  sortOrder: number;
}

export interface CachedModifier {
  id: string;
  groupId: string;
  name: string;
  priceAdjustment: string | number;
  sortOrder: number;
}

export interface CatalogDelta {
  menu_version: number;
  synced_at: string;
  categories: CachedCategory[];
  items: CachedMenuItem[];
  modifiers: CachedModifier[];
}

const DB_NAME = "kitchgoo_pos_cache";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function getDB(): Promise<IDBDatabase> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("IndexedDB is only accessible in browser environment"));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        if (!db.objectStoreNames.contains("categories")) {
          const catStore = db.createObjectStore("categories", { keyPath: "id" });
          catStore.createIndex("sortOrder", "sortOrder", { unique: false });
        }

        if (!db.objectStoreNames.contains("items")) {
          const itemStore = db.createObjectStore("items", { keyPath: "id" });
          itemStore.createIndex("categoryId", "categoryId", { unique: false });
          itemStore.createIndex("sortOrder", "sortOrder", { unique: false });
        }

        if (!db.objectStoreNames.contains("modifiers")) {
          const modStore = db.createObjectStore("modifiers", { keyPath: "id" });
          modStore.createIndex("groupId", "groupId", { unique: false });
        }

        if (!db.objectStoreNames.contains("sync_meta")) {
          db.createObjectStore("sync_meta", { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return dbPromise;
}

/**
 * Retrieve all active cached categories, menu items, and modifiers for zero-latency POS rendering.
 */
export async function getCachedMenu(branchId: string): Promise<{
  categories: CachedCategory[];
  items: CachedMenuItem[];
  modifiers: CachedModifier[];
  lastSyncedAt: string | null;
  menuVersion: number;
}> {
  try {
    const db = await getDB();

    const [categories, items, modifiers, meta] = await Promise.all([
      getAllFromStore<CachedCategory>(db, "categories"),
      getAllFromStore<CachedMenuItem>(db, "items"),
      getAllFromStore<CachedModifier>(db, "modifiers"),
      getMeta(db, `meta:${branchId}`),
    ]);

    return {
      categories: categories.filter((c) => c.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
      items: items.filter((i) => i.isActive).sort((a, b) => a.sortOrder - b.sortOrder),
      modifiers: modifiers.sort((a, b) => a.sortOrder - b.sortOrder),
      lastSyncedAt: meta?.lastSyncedAt ?? null,
      menuVersion: meta?.menuVersion ?? 0,
    };
  } catch (err) {
    console.warn("Failed to read from IndexedDB menu cache:", err);
    return { categories: [], items: [], modifiers: [], lastSyncedAt: null, menuVersion: 0 };
  }
}

/**
 * Persist delta update (only rows touched since previous sync) into IndexedDB.
 */
export async function saveCatalogDelta(branchId: string, delta: CatalogDelta): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(["categories", "items", "modifiers", "sync_meta"], "readwrite");

  const catStore = tx.objectStore("categories");
  const itemStore = tx.objectStore("items");
  const modStore = tx.objectStore("modifiers");
  const metaStore = tx.objectStore("sync_meta");

  for (const cat of delta.categories) {
    catStore.put(cat);
  }

  for (const item of delta.items) {
    itemStore.put(item);
  }

  for (const mod of delta.modifiers) {
    modStore.put(mod);
  }

  metaStore.put({
    key: `meta:${branchId}`,
    lastSyncedAt: delta.synced_at,
    menuVersion: delta.menu_version,
  });

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getAllFromStore<T>(db: IDBDatabase, storeName: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readonly");
    const store = tx.objectStore(storeName);
    const request = store.getAll();

    request.onsuccess = () => resolve((request.result as T[]) || []);
    request.onerror = () => reject(request.error);
  });
}

function getMeta(
  db: IDBDatabase,
  key: string,
): Promise<{ key: string; lastSyncedAt: string; menuVersion: number } | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sync_meta", "readonly");
    const store = tx.objectStore("sync_meta");
    const request = store.get(key);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
