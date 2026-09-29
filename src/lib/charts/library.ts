/**
 * The installed chart cells: files sorted into cells (a base .000 and its
 * updates), merged with what is installed, and kept in IndexedDB so they are
 * there next time. The raw files are kept, not the features: updates apply to
 * records, and a new update means drawing the cell again from them.
 */
import { isZip, readZip } from '../zip'

export interface StoredCell {
  /** The cell's name without extension, upper case: US5ME11M. */
  name: string
  base: Uint8Array
  updates: Array<{ n: number; bytes: Uint8Array }>
  addedAt: number
}

export interface IncomingCell {
  name: string
  base: Uint8Array | null
  updates: Array<{ n: number; bytes: Uint8Array }>
}

const CELL_FILE = /(?:^|\/)([^/]+)\.(\d{3})$/i

/**
 * Sort files (loose, from a folder, or zipped exchange sets) into cells. The
 * exchange set's catalogue (CATALOG.031) and anything not a cell file are
 * passed over.
 */
export function groupCellFiles(files: Array<{ name: string; bytes: Uint8Array }>): { cells: IncomingCell[]; skipped: string[] } {
  const byName = new Map<string, IncomingCell>()
  const skipped: string[] = []
  const take = (path: string, bytes: Uint8Array) => {
    const m = CELL_FILE.exec(path.replace(/\\/g, '/'))
    if (!m || /^catalog$/i.test(m[1])) {
      if (!/(^|\/)catalog\.031$/i.test(path)) skipped.push(path)
      return
    }
    const name = m[1].toUpperCase()
    const n = Number(m[2])
    const c = byName.get(name) ?? { name, base: null, updates: [] }
    byName.set(name, c)
    if (n === 0) c.base = bytes
    else c.updates = [...c.updates.filter((u) => u.n !== n), { n, bytes }]
  }
  for (const f of files) {
    if (isZip(f.bytes)) for (const e of readZip(f.bytes)) take(e.name, e.bytes)
    else take(f.name, f.bytes)
  }
  for (const c of byName.values()) c.updates.sort((a, b) => a.n - b.n)
  return { cells: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), skipped }
}

/**
 * What to keep for a cell: a new base replaces the installed one and its
 * updates; updates alone are added to the installed cell, a newer copy of an
 * update replacing the older.
 */
export function mergeCell(installed: StoredCell | undefined, incoming: IncomingCell, now: number): StoredCell | { error: string } {
  if (incoming.base) return { name: incoming.name, base: incoming.base, updates: incoming.updates, addedAt: now }
  if (!installed) return { error: `${incoming.name}: update files without the base cell (.000)` }
  const keep = installed.updates.filter((u) => !incoming.updates.some((v) => v.n === u.n))
  return { ...installed, updates: [...keep, ...incoming.updates].sort((a, b) => a.n - b.n) }
}

// ------------------------------------------------------------------ store

export interface CellStore {
  list(): Promise<StoredCell[]>
  put(c: StoredCell): Promise<void>
  remove(name: string): Promise<void>
  clear(): Promise<void>
}

export class MemoryCellStore implements CellStore {
  private cells = new Map<string, StoredCell>()
  async list() {
    return [...this.cells.values()]
  }
  async put(c: StoredCell) {
    this.cells.set(c.name, c)
  }
  async remove(name: string) {
    this.cells.delete(name)
  }
  async clear() {
    this.cells.clear()
  }
}

const DB = 'newjourney-charts'
const CELLS = 'cells'

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })

class IdbCellStore implements CellStore {
  private db: Promise<IDBDatabase> | null = null
  private get conn() {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(CELLS, { keyPath: 'name' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return this.db
  }
  private async os(mode: IDBTransactionMode) {
    return (await this.conn).transaction(CELLS, mode).objectStore(CELLS)
  }
  async list() {
    return (await request((await this.os('readonly')).getAll())) as StoredCell[]
  }
  async put(c: StoredCell) {
    await request((await this.os('readwrite')).put(c))
  }
  async remove(name: string) {
    await request((await this.os('readwrite')).delete(name))
  }
  async clear() {
    await request((await this.os('readwrite')).clear())
  }
}

let store: CellStore | null = null

/** The installed cells: IndexedDB where there is one, memory where there is not. */
export function cellStore(): CellStore {
  store ??= typeof indexedDB !== 'undefined' ? new IdbCellStore() : new MemoryCellStore()
  return store
}

export function setCellStore(s: CellStore) {
  store = s
}
