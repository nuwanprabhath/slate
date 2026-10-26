/**
 * The git personal access token field (Settings → Sync). A sync credential, not a vault secret: SyncConfig
 * carries it to main as a string, which seals it with safeStorage's string API (B-5). It is the one masked
 * field `slate/secrets-out-of-react-state` lets hold its text in React state, and only in this file; moving
 * it to bytes is outside C7 (review C7 L3).
 */
export function SyncTokenField({ value, onChange }: { value: string; onChange: (token: string) => void }) {
  return <input data-testid="git-token" type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
}
