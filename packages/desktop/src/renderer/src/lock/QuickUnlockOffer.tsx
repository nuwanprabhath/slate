import { useEffect, useState } from 'react'
import type { QuickUnlockKind } from '../../../shared/api'
import { QuickUnlockRow } from '../settings/QuickUnlockRow'
import { quickUnlockOfferText } from './quickUnlockText'
import './lock.css'

/** §8: after Touch ID or the keyring failed and the password worked, offer to set quick unlock up again. */
export function QuickUnlockOffer() {
  const [show, setShow] = useState(false)
  const [kind, setKind] = useState<QuickUnlockKind>('touchid')
  const [setup, setSetup] = useState(false)

  useEffect(() => {
    void window.slate.vault
      .quickUnlockInfo()
      .then((i) => {
        if (i.kind) setKind(i.kind)
        setShow(i.offerReenable && i.kind !== null)
      })
      .catch(() => {})
  }, [])

  if (!show) return null
  return (
    <div className="migration-banner" data-testid="quick-unlock-offer" role="status">
      {setup ? (
        <QuickUnlockRow />
      ) : (
        <>
          <span className="migration-banner-text">{quickUnlockOfferText(kind)}</span>
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
