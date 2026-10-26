import { useEffect, useState } from 'react'
import { QuickUnlockRow } from '../settings/QuickUnlockRow'
import './lock.css'

/** §8: after Touch ID failed and the password worked, offer to set quick unlock up again. */
export function QuickUnlockOffer() {
  const [show, setShow] = useState(false)
  const [setup, setSetup] = useState(false)

  useEffect(() => {
    void window.slate.vault
      .quickUnlockInfo()
      .then((i) => setShow(i.offerReenable && i.kind !== null))
      .catch(() => {})
  }, [])

  if (!show) return null
  return (
    <div className="migration-banner" data-testid="quick-unlock-offer" role="status">
      {setup ? (
        <QuickUnlockRow />
      ) : (
        <>
          <span className="migration-banner-text">Touch ID unlock stopped working. Set it up again?</span>
          <button type="button" onClick={() => setSetup(true)}>
            Set up again
          </button>
        </>
      )}
      <button type="button" onClick={() => setShow(false)}>
        Not now
      </button>
    </div>
  )
}
