import { useEffect, useState } from 'react'
import type { DeviceCode, GitAuthInfo, GitAuthMode, GitCheck, GitSettings, SyncProvider } from '../../../shared/api'
import { SyncTokenField } from './SyncTokenField'

const AUTH_LABELS: Record<GitAuthMode, string> = {
  system: "Use this computer's git setup (SSH key or credential helper)",
  gh: 'GitHub CLI (gh)',
  token: 'Personal access token',
  device: 'Sign in with GitHub',
}

/**
 * Settings → Sync: where notebooks sync to. Saved with its own button, not field by field, because
 * the provider, remote and token only make sense together. A token typed here goes to the main
 * process and is stored encrypted.
 */
export function SyncSection({ onClose }: { onClose: () => void }) {
  const [provider, setProvider] = useState<SyncProvider | null>(null)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [auth, setAuth] = useState<GitAuthMode>('system')
  const [token, setToken] = useState('')
  const [info, setInfo] = useState<GitAuthInfo | null>(null)
  const [check, setCheck] = useState<GitCheck | null>(null)
  const [busy, setBusy] = useState(false)
  const [repoName, setRepoName] = useState('slate-notes')
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    void Promise.all([window.slate.settings.get(), window.slate.sync.gitAuthInfo()]).then(([settings, authInfo]) => {
      setProvider(settings.syncProvider)
      if (settings.git) {
        setRemoteUrl(settings.git.remoteUrl)
        setBranch(settings.git.branch)
        setAuth(settings.git.auth)
      }
      setInfo(authInfo)
      setLoaded(true)
    })
  }, [])

  const git = (): GitSettings => ({ remoteUrl: remoteUrl.trim(), branch: branch.trim() || 'main', auth })
  const typedToken = auth === 'token' && token ? token : undefined
  const canCreate = auth === 'gh' || auth === 'device' || (auth === 'token' && (token !== '' || info?.hasToken === true))
  const modes = (Object.keys(AUTH_LABELS) as GitAuthMode[]).filter((m) => m !== 'device' || info?.deviceFlow)

  const run = async (task: () => Promise<GitCheck>) => {
    setBusy(true)
    try {
      setCheck(await task())
    } catch (err) {
      setCheck({ ok: false, message: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(false)
    }
  }

  const test = () => run(() => window.slate.sync.testGit(git(), typedToken))
  const create = () =>
    run(async () => {
      const result = await window.slate.sync.createRepo(repoName.trim(), auth, typedToken)
      if (result.ok && result.url) setRemoteUrl(result.url)
      return result
    })
  const signIn = () =>
    run(async () => {
      setDeviceCode(await window.slate.sync.deviceSignIn())
      const result = await window.slate.sync.deviceSignInWait()
      setDeviceCode(null)
      if (result.ok) setInfo(await window.slate.sync.gitAuthInfo())
      return result
    })
  const save = async () => {
    if (provider === 'git' && !remoteUrl.trim()) {
      setCheck({ ok: false, message: 'Enter the repository URL' })
      return
    }
    setBusy(true)
    try {
      await window.slate.sync.configure({ provider, ...(provider === 'git' ? { git: git(), ...(typedToken ? { token: typedToken } : {}) } : {}) })
      onClose()
    } catch (err) {
      setCheck({ ok: false, message: err instanceof Error ? err.message : String(err) })
      setBusy(false)
    }
  }

  return (
    <div data-testid="sync-settings">
      <div className="sync-settings">
        {loaded && (
          <>
            <fieldset>
              <legend>Sync to</legend>
              {([null, 'onedrive', 'git'] as const).map((p) => (
                <label key={p ?? 'off'}>
                  <input type="radio" name="sync-provider" data-testid={`sync-provider-${p ?? 'off'}`} checked={provider === p} onChange={() => setProvider(p)} />
                  {p === null ? 'Off' : p === 'onedrive' ? 'OneDrive' : 'Git repository'}
                </label>
              ))}
            </fieldset>
            {provider === 'git' && (
              <>
                <label className="sync-field">
                  Repository URL
                  <input
                    data-testid="git-remote-url"
                    value={remoteUrl}
                    placeholder="git@github.com:you/slate-notes.git or https://…"
                    spellCheck={false}
                    autoCapitalize="off"
                    autoCorrect="off"
                    onChange={(e) => setRemoteUrl(e.target.value)}
                  />
                </label>
                <label className="sync-field">
                  Branch
                  <input data-testid="git-branch" value={branch} spellCheck={false} onChange={(e) => setBranch(e.target.value)} />
                </label>
                <fieldset>
                  <legend>Sign in with</legend>
                  {modes.map((m) => (
                    <label key={m}>
                      <input type="radio" name="git-auth" data-testid={`git-auth-${m}`} checked={auth === m} onChange={() => setAuth(m)} />
                      {AUTH_LABELS[m]}
                    </label>
                  ))}
                </fieldset>
                {auth === 'token' && (
                  <label className="sync-field">
                    Personal access token{info?.hasToken ? ' (one is saved; type to replace it)' : ''}
                    <SyncTokenField value={token} onChange={setToken} />
                  </label>
                )}
                {auth === 'device' && (
                  <div className="sync-row">
                    <button type="button" data-testid="git-device-sign-in" disabled={busy} onClick={() => void signIn()}>
                      {info?.hasDeviceToken ? 'Sign in again' : 'Sign in with GitHub'}
                    </button>
                    {deviceCode && (
                      <span data-testid="git-device-code">
                        Enter <strong>{deviceCode.userCode}</strong> at {deviceCode.verificationUri}
                      </span>
                    )}
                  </div>
                )}
                {canCreate && (
                  <div className="sync-row">
                    <input aria-label="New repository name" data-testid="git-repo-name" value={repoName} spellCheck={false} onChange={(e) => setRepoName(e.target.value)} />
                    <button type="button" data-testid="git-create-repo" disabled={busy || !repoName.trim()} onClick={() => void create()}>
                      Create a private repository for me…
                    </button>
                  </div>
                )}
              </>
            )}
            {check && (
              <div className={`sync-check ${check.ok ? 'ok' : 'failed'}`} data-testid="sync-check" role="status">
                {check.message}
              </div>
            )}
            <div className="sync-settings-actions">
              {provider === 'git' && (
                <button type="button" data-testid="git-test" disabled={busy || !remoteUrl.trim()} onClick={() => void test()}>
                  Test connection
                </button>
              )}
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              <button type="button" data-testid="sync-settings-save" disabled={busy} onClick={() => void save()}>
                Save &amp; sync
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
