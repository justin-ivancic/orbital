/**
 * A small asynchronous key-value cache in IndexedDB. It replaces the old
 * synchronous localStorage snapshot, which blocked the page for every write of
 * the (multi-megabyte) library.
 */

const databaseName = 'orbital-app-cache'
const databaseVersion = 1
const storeName = 'entries'

type CacheRecord = {
  key: string
  value: unknown
  savedAt: number
}

let databasePromise: Promise<IDBDatabase | null> | null = null

const openDatabase = () => {
  if (databasePromise) {
    return databasePromise
  }

  databasePromise = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null)
      return
    }

    let request: IDBOpenDBRequest

    try {
      request = indexedDB.open(databaseName, databaseVersion)
    } catch {
      resolve(null)
      return
    }

    request.onupgradeneeded = () => {
      const db = request.result

      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'key' })
      }
    }

    request.onsuccess = () => {
      const db = request.result
      db.onversionchange = () => {
        db.close()
        databasePromise = null
      }
      resolve(db)
    }

    request.onerror = () => resolve(null)
    request.onblocked = () => resolve(null)
  })

  return databasePromise
}

const runRequest = <T,>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
) =>
  openDatabase().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) {
          resolve(undefined)
          return
        }

        try {
          const transaction = db.transaction(storeName, mode)
          const request = operation(transaction.objectStore(storeName))
          transaction.oncomplete = () => resolve(request.result)
          transaction.onerror = () => resolve(undefined)
          transaction.onabort = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )

export const cacheGet = async <T,>(key: string): Promise<T | null> => {
  const record = await runRequest<CacheRecord | undefined>('readonly', (store) => store.get(key))
  return record ? (record.value as T) : null
}

export const cacheSet = async (key: string, value: unknown) => {
  await runRequest('readwrite', (store) =>
    store.put({ key, value, savedAt: Date.now() } satisfies CacheRecord),
  )
}

export const cacheDelete = async (key: string) => {
  await runRequest('readwrite', (store) => store.delete(key))
}

/** Lists the keys that start with `prefix`. */
export const cacheKeys = async (prefix: string) => {
  const keys = await runRequest<IDBValidKey[]>('readonly', (store) =>
    store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`)),
  )

  return (keys ?? []).map(String)
}

export const cacheDeletePrefix = async (prefix: string) => {
  await runRequest('readwrite', (store) =>
    store.delete(IDBKeyRange.bound(prefix, `${prefix}￿`)),
  )
}

export const cacheClear = async () => {
  await runRequest('readwrite', (store) => store.clear())
}
