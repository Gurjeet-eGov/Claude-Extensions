// IndexedDB shared by the service worker, the Recorder window and extension pages
// (all run on the extension's origin).

const DB_NAME = 'egov-bug-reporter';
const DB_VERSION = 1;
let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('calls')) {
        const s = db.createObjectStore('calls', { keyPath: 'id' });
        s.createIndex('tabTs', ['tabId', 'ts']);
      }
      if (!db.objectStoreNames.contains('consoleLogs')) {
        const s = db.createObjectStore('consoleLogs', { keyPath: 'id' });
        s.createIndex('tabTs', ['tabId', 'ts']);
      }
      if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('reports')) db.createObjectStore('reports', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('usage')) db.createObjectStore('usage', { keyPath: 'ts' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function result(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
  return value;
}

export async function putMany(store, values) {
  if (!values.length) return;
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const s = tx.objectStore(store);
  for (const v of values) s.put(v);
  await done(tx);
}

export async function get(store, key) {
  const db = await openDb();
  return result(db.transaction(store).objectStore(store).get(key));
}

export async function del(store, key) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export async function getAll(store) {
  const db = await openDb();
  return result(db.transaction(store).objectStore(store).getAll());
}

/** Rows of one tab between two timestamps, oldest first. */
export async function byTab(store, tabId, fromTs = 0, toTs = Number.MAX_SAFE_INTEGER) {
  const db = await openDb();
  const range = IDBKeyRange.bound([tabId, fromTs], [tabId, toTs]);
  return result(db.transaction(store).objectStore(store).index('tabTs').getAll(range));
}

export async function countByTab(store, tabId) {
  const db = await openDb();
  const range = IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]);
  return result(db.transaction(store).objectStore(store).index('tabTs').count(range));
}

/** Keeps at most `maxRows` rows per tab and drops rows older than `minTs`. */
export async function pruneTab(store, tabId, maxRows, minTs) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const idx = tx.objectStore(store).index('tabTs');
  const range = IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]);
  const total = await result(idx.count(range));
  let toDrop = Math.max(0, total - maxRows);
  await new Promise((resolve, reject) => {
    const cur = idx.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (toDrop > 0 || c.value.ts < minTs) {
        c.delete();
        toDrop--;
        c.continue();
      } else resolve();
    };
    cur.onerror = () => reject(cur.error);
  });
  await done(tx);
}

export async function deleteTab(store, tabId) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const idx = tx.objectStore(store).index('tabTs');
  const range = IDBKeyRange.bound([tabId, 0], [tabId, Number.MAX_SAFE_INTEGER]);
  await new Promise((resolve, reject) => {
    const cur = idx.openCursor(range);
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await done(tx);
}

/** Deletes rows of a store whose `field` is older than `minTs` (media, reports). */
export async function deleteOlderThan(store, field, minTs) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  await new Promise((resolve, reject) => {
    const cur = tx.objectStore(store).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if ((c.value?.[field] ?? 0) < minTs) c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await done(tx);
}

/** Deletes every row whose `field` is truthy (e.g. rows captured in Incognito). */
export async function deleteFlagged(store, field) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  await new Promise((resolve, reject) => {
    const cur = tx.objectStore(store).openCursor();
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c) return resolve();
      if (c.value?.[field]) c.delete();
      c.continue();
    };
    cur.onerror = () => reject(cur.error);
  });
  await done(tx);
}

export function newId(prefix = '') {
  const rnd = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${rnd[0].toString(36)}${rnd[1].toString(36)}`;
}
