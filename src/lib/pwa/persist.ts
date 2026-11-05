/**
 * Asking the browser not to clear what is stored here.
 *
 * Tracks, logs and installed charts live in IndexedDB. Unless the origin is marked
 * persistent, a browser short of space may delete them all without asking, which
 * would be found out on the water. Browsers decide for themselves whether to grant
 * it (installed apps do better), so the answer is shown rather than assumed.
 */

export interface StorageStatus {
  /** Null where the browser has no way to say. */
  persisted: boolean | null
  usedMb: number | null
  quotaMb: number | null
}

function storage(): StorageManager | null {
  return typeof navigator === 'undefined' ? null : (navigator.storage ?? null)
}

/** Ask. True once granted, false if refused, null where it cannot be asked. */
export async function requestPersistence(): Promise<boolean | null> {
  const s = storage()
  if (!s?.persist) return null
  try {
    return (await s.persisted?.()) || (await s.persist())
  } catch {
    return null
  }
}

export async function storageStatus(): Promise<StorageStatus> {
  const s = storage()
  const persisted = (await s?.persisted?.().catch(() => null)) ?? null
  const estimate = (await s?.estimate?.().catch(() => null)) ?? null
  const mb = (n: number | undefined) => (n == null ? null : n / (1024 * 1024))
  return { persisted, usedMb: mb(estimate?.usage), quotaMb: mb(estimate?.quota) }
}
