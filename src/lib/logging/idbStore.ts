/**
 * The log in IndexedDB: one record per second, keyed by day and time, so a day
 * reads back in order and deletes in one range.
 */

import { MemoryLogStore, type LogRow, type LogStore } from './logger'

const DB = 'newjourney-logs'
const ROWS = 'rows'

interface Stored {
  day: string
  t: number
  v: Record<string, number>
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const os = req.result.createObjectStore(ROWS, { keyPath: ['day', 't'] })
      os.createIndex('day', 'day')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

export class IdbLogStore implements LogStore {
  private db: Promise<IDBDatabase> | null = null
  private get conn() {
    this.db ??= open()
    return this.db
  }

  async append(day: string, rows: LogRow[]) {
    const tx = (await this.conn).transaction(ROWS, 'readwrite')
    const os = tx.objectStore(ROWS)
    for (const r of rows) os.put({ day, t: r.t, v: r.v } satisfies Stored)
    await done(tx)
  }

  async days() {
    const os = (await this.conn).transaction(ROWS).objectStore(ROWS)
    const keys = (await request(os.getAllKeys())) as Array<[string, number]>
    const counts = new Map<string, number>()
    for (const [day] of keys) counts.set(day, (counts.get(day) ?? 0) + 1)
    return [...counts].map(([day, rows]) => ({ day, rows }))
  }

  async read(day: string) {
    const os = (await this.conn).transaction(ROWS).objectStore(ROWS)
    const got = (await request(os.index('day').getAll(IDBKeyRange.only(day)))) as Stored[]
    return got.sort((a, b) => a.t - b.t).map((s) => ({ t: s.t, v: s.v }))
  }

  async deleteDay(day: string) {
    const tx = (await this.conn).transaction(ROWS, 'readwrite')
    tx.objectStore(ROWS).delete(IDBKeyRange.bound([day, -Infinity], [day, Infinity]))
    await done(tx)
  }
}

let store: LogStore | null = null

/** The app's log: IndexedDB where there is one, memory where there is not. */
export function logStore(): LogStore {
  store ??= typeof indexedDB !== 'undefined' ? new IdbLogStore() : new MemoryLogStore()
  return store
}

/** For tests: put a store of your own in place. */
export function setLogStore(s: LogStore | null): void {
  store = s
}
