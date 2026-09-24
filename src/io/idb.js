// @ts-check
/**
 * IndexedDB 래퍼(D-04). 스토어: handles, journal, backups, known_revisions, settings.
 *
 * 기능 감지로만 쓴다. 열기에 실패하면 `openIdb()`는 null을 돌려주고 앱은 1·2층(정본 파일, 다운로드)만으로 동작한다.
 * 모든 메서드는 Promise를 돌려주며 오류는 AppError(`E_QUOTA` 또는 `E_ENV_NO_IDB`)다.
 */
import { AppError } from '../util/errors.js';

export const IDB_NAME = 'jdrdatabase';
export const IDB_VERSION = 1;

/** @typedef {'handles' | 'journal' | 'backups' | 'known_revisions' | 'settings'} StoreName */
/** 스토어 목록. `journal`만 자동 증가 키를 쓴다(순서 보존). */
export const STORE_NAMES = Object.freeze(
  /** @type {const} */ (['handles', 'journal', 'backups', 'known_revisions', 'settings']),
);

/**
 * 스토어 접근 인터페이스. 테스트는 같은 형태의 메모리 구현을 쓴다.
 * @typedef {object} Idb
 * @property {(store: StoreName, key: IDBValidKey) => Promise<unknown>} get
 * @property {(store: StoreName, key: IDBValidKey, value: unknown) => Promise<void>} put
 * @property {(store: StoreName, value: unknown) => Promise<number>} add 자동 증가 키 스토어(journal)에 추가하고 키를 돌려준다
 * @property {(store: StoreName, key: IDBValidKey) => Promise<void>} delete
 * @property {(store: StoreName, options?: { limit?: number }) => Promise<Array<{ key: IDBValidKey, value: unknown }>>} getAll 키 오름차순
 * @property {(store: StoreName) => Promise<IDBValidKey[]>} keys 키 목록(오름차순). 값을 읽지 않으므로 큰 값(직전 저장본은 최대 200 MB)이 있는 스토어의 개수를 셀 때 쓴다
 * @property {(store: StoreName) => Promise<void>} clear
 * @property {() => void} close
 */

/**
 * @param {unknown} err
 * @returns {AppError}
 */
function toIdbError(err) {
  if (err instanceof AppError) return err;
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  const message = err instanceof Error ? err.message : String(err);
  if (name === 'QuotaExceededError') {
    return new AppError('E_QUOTA', message, { cause: err });
  }
  return new AppError('E_ENV_NO_IDB', message || name || 'IndexedDB error', { cause: err });
}

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toIdbError(request.error));
  });
}

/**
 * @param {IDBTransaction} tx
 * @returns {Promise<void>}
 */
function transactionDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(toIdbError(tx.error));
    tx.onabort = () => reject(toIdbError(tx.error ?? new Error('transaction aborted')));
  });
}

/**
 * @param {IDBDatabase} db
 * @returns {Idb}
 */
function wrap(db) {
  /**
   * @template T
   * @param {StoreName} store
   * @param {IDBTransactionMode} mode
   * @param {(s: IDBObjectStore) => IDBRequest<T>} fn
   * @returns {Promise<T>}
   */
  async function run(store, mode, fn) {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    const [result] = await Promise.all([requestToPromise(request), transactionDone(tx)]);
    return result;
  }

  return {
    get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
    put: (store, key, value) =>
      run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined),
    add: (store, value) => run(store, 'readwrite', (s) => s.add(value)).then((k) => Number(k)),
    delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined),
    async getAll(store, options = {}) {
      const tx = db.transaction(store, 'readonly');
      const s = tx.objectStore(store);
      const [keys, values] = await Promise.all([
        requestToPromise(s.getAllKeys(undefined, options.limit)),
        requestToPromise(s.getAll(undefined, options.limit)),
        transactionDone(tx),
      ]);
      return keys.map((key, i) => ({ key, value: values[i] }));
    },
    keys: (store) => run(store, 'readonly', (s) => s.getAllKeys()),
    clear: (store) => run(store, 'readwrite', (s) => s.clear()).then(() => undefined),
    close: () => db.close(),
  };
}

/**
 * @typedef {object} OpenIdbOptions
 * @property {string} [name]
 * @property {IDBFactory} [factory] 테스트용 주입. 기본 `globalThis.indexedDB`
 */

/**
 * IndexedDB를 연다. 사용할 수 없으면(전역 없음, `file://` 제한, 열기 실패) null.
 * 실패 원인은 `E_ENV_NO_IDB`로 감싸 두 번째 반환값에 둔다(호출자가 상태바에 표시).
 * @param {OpenIdbOptions} [options]
 * @returns {Promise<{ idb: Idb | null, error: AppError | null }>}
 */
export async function openIdb(options = {}) {
  /** @type {IDBFactory | undefined} */
  let factory;
  try {
    factory = options.factory ?? globalThis.indexedDB;
  } catch (err) {
    return { idb: null, error: toIdbError(err) };
  }
  if (!factory || typeof factory.open !== 'function') {
    return { idb: null, error: new AppError('E_ENV_NO_IDB', 'indexedDB is not available') };
  }
  try {
    const request = factory.open(options.name ?? IDB_NAME, IDB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const name of STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, name === 'journal' ? { autoIncrement: true } : undefined);
        }
      }
    };
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(toIdbError(request.error));
      request.onblocked = () => reject(new AppError('E_ENV_NO_IDB', 'indexedDB open blocked'));
    });
    return { idb: wrap(/** @type {IDBDatabase} */ (db)), error: null };
  } catch (err) {
    return { idb: null, error: toIdbError(err) };
  }
}

/**
 * 메모리 구현. IndexedDB가 없는 Node 테스트가 같은 인터페이스로 저널·revision 로직을 검사한다.
 * 앱 런타임 폴백으로는 쓰지 않는다(D-04: IDB가 없으면 1·2층만으로 동작).
 * @returns {Idb & { dump: () => Record<string, Array<[IDBValidKey, unknown]>> }}
 */
export function createMemoryIdb() {
  /** @type {Map<StoreName, Map<IDBValidKey, unknown>>} */
  const stores = new Map(STORE_NAMES.map((n) => [n, new Map()]));
  let nextKey = 1;
  /** @param {StoreName} name */
  const s = (name) => {
    const m = stores.get(name);
    if (!m) throw new AppError('E_ENV_NO_IDB', `no store ${name}`);
    return m;
  };
  /** @param {IDBValidKey} a @param {IDBValidKey} b */
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    get: async (store, key) => structuredClone(s(store).get(key)),
    put: async (store, key, value) => {
      s(store).set(key, structuredClone(value));
    },
    add: async (store, value) => {
      const key = nextKey;
      nextKey += 1;
      s(store).set(key, structuredClone(value));
      return key;
    },
    delete: async (store, key) => {
      s(store).delete(key);
    },
    getAll: async (store, options = {}) => {
      const entries = [...s(store).entries()].sort((a, b) => compare(a[0], b[0]));
      const limited = options.limit ? entries.slice(0, options.limit) : entries;
      return limited.map(([key, value]) => ({ key, value: structuredClone(value) }));
    },
    keys: async (store) => [...s(store).keys()].sort(compare),
    clear: async (store) => {
      s(store).clear();
    },
    close: () => {},
    dump: () => {
      /** @type {Record<string, Array<[IDBValidKey, unknown]>>} */
      const out = {};
      for (const [name, m] of stores) out[name] = [...m.entries()];
      return out;
    },
  };
}
