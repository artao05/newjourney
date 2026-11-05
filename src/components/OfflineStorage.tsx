/**
 * Setup → Stored data: whether the browser has agreed to keep tracks, logs and
 * charts, how much they take, and a way to ask again.
 */

import { useEffect, useState } from 'react'
import { requestPersistence, storageStatus, type StorageStatus } from '@/lib/pwa/persist'

export function OfflineStorage() {
  const [status, setStatus] = useState<StorageStatus | null>(null)
  const refresh = () => void storageStatus().then(setStatus)
  useEffect(refresh, [])
  if (!status) return null

  const { persisted, usedMb, quotaMb } = status
  return (
    <section aria-label="Stored data">
      <h2>Stored data</h2>
      {persisted === true && <p className="note">Kept: the browser has agreed not to clear tracks, logs and charts.</p>}
      {persisted === false && (
        <>
          <p className="warnbox">
            Not protected: this browser may clear tracks, logs and charts if the phone runs short of
            space. Adding the app to the home screen makes it more likely to agree. Export anything
            you need to keep.
          </p>
          <button className="btn btn--sm" onClick={() => void requestPersistence().then(refresh)}>
            ASK TO KEEP DATA
          </button>
        </>
      )}
      {persisted === null && (
        <p className="note">This browser cannot say whether it will keep tracks, logs and charts. Export anything you need to keep.</p>
      )}
      {usedMb != null && (
        <p className="note">
          Using {usedMb < 10 ? usedMb.toFixed(1) : Math.round(usedMb)} MB{quotaMb != null ? ` of about ${Math.round(quotaMb)} MB allowed` : ''}.
        </p>
      )}
    </section>
  )
}
