const DATABASE_NAME = "wurenji-drafts"
const STORE_NAME = "drafts"

export interface LocalDraftRecord<T> {
  value: T
  savedAt: string
}

function isDraftRecord<T>(value: unknown): value is LocalDraftRecord<T> {
  return typeof value === "object" && value !== null && "value" in value && "savedAt" in value
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function saveLocalDraft<T>(key: string, value: T): Promise<void> {
  const database = await openDatabase()
  const serializableValue: LocalDraftRecord<T> = {
    value: JSON.parse(JSON.stringify(value)) as T,
    savedAt: new Date().toISOString()
  }
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, "readwrite")
    transaction.objectStore(STORE_NAME).put(serializableValue, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function loadLocalDraft<T>(key: string): Promise<T | null> {
  return (await loadLocalDraftRecord<T>(key))?.value ?? null
}

export async function loadLocalDraftRecord<T>(key: string): Promise<LocalDraftRecord<T> | null> {
  const database = await openDatabase()
  const value = await new Promise<unknown>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  database.close()
  if (isDraftRecord<T>(value)) return value
  if (value === undefined || value === null) return null
  return { value: value as T, savedAt: "" }
}
