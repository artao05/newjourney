import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestPersistence, storageStatus } from './persist'

const withStorage = (storage: Partial<StorageManager> | undefined) => vi.stubGlobal('navigator', { storage })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('persistent storage', () => {
  it('asks when not yet granted, and reports the answer', async () => {
    const persist = vi.fn(async () => true)
    withStorage({ persisted: async () => false, persist })
    expect(await requestPersistence()).toBe(true)
    expect(persist).toHaveBeenCalledOnce()
  })

  it('does not ask again once granted', async () => {
    const persist = vi.fn(async () => true)
    withStorage({ persisted: async () => true, persist })
    expect(await requestPersistence()).toBe(true)
    expect(persist).not.toHaveBeenCalled()
  })

  it('reports a refusal as a refusal', async () => {
    withStorage({ persisted: async () => false, persist: async () => false })
    expect(await requestPersistence()).toBe(false)
  })

  it('says it cannot ask, on a browser without the API or when it throws', async () => {
    withStorage(undefined)
    expect(await requestPersistence()).toBeNull()
    withStorage({ persisted: async () => false, persist: async () => { throw new Error('no') } })
    expect(await requestPersistence()).toBeNull()
  })

  it('gives the status in megabytes, and nulls for what it cannot tell', async () => {
    withStorage({ persisted: async () => true, estimate: async () => ({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }) })
    expect(await storageStatus()).toEqual({ persisted: true, usedMb: 5, quotaMb: 100 })
    withStorage(undefined)
    expect(await storageStatus()).toEqual({ persisted: null, usedMb: null, quotaMb: null })
  })
})
