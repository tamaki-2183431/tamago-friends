/**
 * IndexedDB の唯一の窓口。ここ以外からは indexedDB を触らない。
 * 保存層を差し替えられるようにするため、上位（store/*）はこの API だけを使う。
 *
 * ストアは親データ（p_*）と子どもデータ（c_*）で分ける。
 * 親端末には親ストアだけ、子端末には子ストアだけが入る。
 */

export const DB_NAME = 'tamago-friends';
export const DB_VERSION = 5;

export const STORES = Object.freeze({
  // 親端末
  P_META: 'p_meta', // 家族設定・PIN・署名鍵
  P_CHILDREN: 'p_children', // 子ども
  P_SCORES: 'p_scores', // 点数記録
  P_AUDIT: 'p_audit', // 監査履歴
  P_REWARDS: 'p_rewards', // ごほうび
  P_REQUESTS: 'p_requests', // ごほうび申請と承認
  P_OUTBOX: 'p_outbox', // 子端末へまだ送っていない訂正イベント
  P_SNAPSHOTS: 'p_snapshots', // 復元前の自動退避
  P_MEMOS: 'p_memos', // ごほうびメモ（1,000点達成ごとの1行）
  C_ROOM: 'c_room', // ペットルーム（広さ・天気・チュートリアル・家具）
  // 子端末
  C_META: 'c_meta', // ペアリング情報
  C_EVENTS: 'c_events', // 受け取った点数イベント
  C_STATE: 'c_state', // 累計・最高到達点・孵化権
  C_CATALOG: 'c_catalog', // 親から受け取ったごほうび一覧
  C_REQUESTS: 'c_requests', // ごほうび申請の状態
  C_PETS: 'c_pets', // ペット（Phase 2）
  C_COINS: 'c_coins', // コインの台帳（Phase 2）
  C_SETTINGS: 'c_settings', // 音などの設定（Phase 2）
  C_SNAPSHOTS: 'c_snapshots', // 復元前の自動退避（子端末）
  C_DEX: 'c_dex', // ずかん（種の発見・おきにいり・v42）
  C_DEX_RECORDS: 'c_dex_records', // ずかんの成長の記録（1件=1行・v42）
});

export const PARENT_STORES = [
  STORES.P_META,
  STORES.P_CHILDREN,
  STORES.P_SCORES,
  STORES.P_AUDIT,
  STORES.P_REWARDS,
  STORES.P_REQUESTS,
  STORES.P_OUTBOX,
  STORES.P_SNAPSHOTS,
  STORES.P_MEMOS,
];

export const CHILD_STORES = [
  STORES.C_META,
  STORES.C_EVENTS,
  STORES.C_STATE,
  STORES.C_CATALOG,
  STORES.C_REQUESTS,
  STORES.C_PETS,
  STORES.C_COINS,
  STORES.C_SETTINGS,
  STORES.C_SNAPSHOTS,
  STORES.C_ROOM,
  STORES.C_DEX,
  STORES.C_DEX_RECORDS,
];

let openPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB エラー'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB エラー'));
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB が中断されました'));
  });
}

export function openDb() {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORES.P_META)) db.createObjectStore(STORES.P_META, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.P_CHILDREN)) {
        db.createObjectStore(STORES.P_CHILDREN, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORES.P_SCORES)) {
        const store = db.createObjectStore(STORES.P_SCORES, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }
      if (!db.objectStoreNames.contains(STORES.P_AUDIT)) {
        const store = db.createObjectStore(STORES.P_AUDIT, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }
      if (!db.objectStoreNames.contains(STORES.P_REWARDS)) {
        const store = db.createObjectStore(STORES.P_REWARDS, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }
      if (!db.objectStoreNames.contains(STORES.P_REQUESTS)) {
        const store = db.createObjectStore(STORES.P_REQUESTS, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }
      if (!db.objectStoreNames.contains(STORES.P_OUTBOX)) {
        const store = db.createObjectStore(STORES.P_OUTBOX, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }
      if (!db.objectStoreNames.contains(STORES.P_SNAPSHOTS)) db.createObjectStore(STORES.P_SNAPSHOTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.C_ROOM)) db.createObjectStore(STORES.C_ROOM, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.P_MEMOS)) {
        const store = db.createObjectStore(STORES.P_MEMOS, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }

      if (!db.objectStoreNames.contains(STORES.C_META)) db.createObjectStore(STORES.C_META, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.C_EVENTS)) {
        const store = db.createObjectStore(STORES.C_EVENTS, { keyPath: 'id' });
        store.createIndex('childId', 'childId');
      }
      if (!db.objectStoreNames.contains(STORES.C_STATE)) db.createObjectStore(STORES.C_STATE, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.C_CATALOG)) db.createObjectStore(STORES.C_CATALOG, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.C_REQUESTS)) db.createObjectStore(STORES.C_REQUESTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.C_PETS)) {
        const store = db.createObjectStore(STORES.C_PETS, { keyPath: 'id' });
        store.createIndex('hatchedAt', 'hatchedAt');
      }
      if (!db.objectStoreNames.contains(STORES.C_COINS)) db.createObjectStore(STORES.C_COINS, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.C_SETTINGS)) db.createObjectStore(STORES.C_SETTINGS, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.C_SNAPSHOTS)) db.createObjectStore(STORES.C_SNAPSHOTS, { keyPath: 'id' });
      // ずかん（v42）。既存ストアには触らない＝追加だけ（上がっても中身は残る）
      if (!db.objectStoreNames.contains(STORES.C_DEX)) db.createObjectStore(STORES.C_DEX, { keyPath: 'k' });
      if (!db.objectStoreNames.contains(STORES.C_DEX_RECORDS)) {
        const store = db.createObjectStore(STORES.C_DEX_RECORDS, { keyPath: 'recordId' });
        store.createIndex('petId', 'petId');
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB を開けませんでした'));
    request.onblocked = () => reject(new Error('別のタブで古いバージョンのアプリが開いています'));
  });
  return openPromise;
}

async function withStore(storeName, mode, run) {
  const db = await openDb();
  const transaction = db.transaction(storeName, mode);
  const store = transaction.objectStore(storeName);
  const result = await run(store);
  await transactionDone(transaction);
  return result;
}

export function get(storeName, key) {
  return withStore(storeName, 'readonly', (store) => requestToPromise(store.get(key)));
}

export function getAll(storeName) {
  return withStore(storeName, 'readonly', (store) => requestToPromise(store.getAll()));
}

export function getAllByIndex(storeName, indexName, value) {
  return withStore(storeName, 'readonly', (store) => requestToPromise(store.index(indexName).getAll(value)));
}

export function put(storeName, value) {
  return withStore(storeName, 'readwrite', async (store) => {
    await requestToPromise(store.put(value));
    return value;
  });
}

export function del(storeName, key) {
  return withStore(storeName, 'readwrite', async (store) => {
    await requestToPromise(store.delete(key));
    return true;
  });
}

export function clear(storeName) {
  return withStore(storeName, 'readwrite', async (store) => {
    await requestToPromise(store.clear());
    return true;
  });
}

/** すべてのストアの中身を { storeName: [records] } で返す */
export async function exportAll() {
  const db = await openDb();
  const names = Array.from(db.objectStoreNames);
  const out = {};
  for (const name of names) out[name] = await getAll(name);
  return out;
}

/** まとめて書き込む（復元用・1トランザクションで失敗時はロールバック） */
export async function importAll(data, { clearFirst = true } = {}) {
  const db = await openDb();
  const names = Object.keys(data).filter((name) => db.objectStoreNames.contains(name));
  const transaction = db.transaction(names, 'readwrite');
  const done = transactionDone(transaction);
  for (const name of names) {
    const store = transaction.objectStore(name);
    if (clearFirst) store.clear();
    for (const record of data[name] ?? []) store.put(record);
  }
  await done;
  return names.length;
}

/** 親ストアだけ消す（家族データの削除） */
export async function clearStores(storeNames) {
  const db = await openDb();
  const names = storeNames.filter((name) => db.objectStoreNames.contains(name));
  if (!names.length) return 0;
  const transaction = db.transaction(names, 'readwrite');
  const done = transactionDone(transaction);
  for (const name of names) transaction.objectStore(name).clear();
  await done;
  return names.length;
}

/** DB ごと削除（テスト用） */
export async function deleteDatabase() {
  if (openPromise) {
    const db = await openPromise.catch(() => null);
    db?.close();
  }
  openPromise = null;
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve(true);
    request.onerror = () => reject(request.error ?? new Error('削除できませんでした'));
    request.onblocked = () => resolve(true);
  });
}
