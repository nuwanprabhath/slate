// POAM-16 (maintainer decision 2026-10-26): the lock window's renderer holds the typed password until it
// exits, and Chromium's sandbox is its protection. The .deb forces the setuid sandbox from its launchers
// (electron-builder.cjs); the AppImage may run with none at all (its AppRun adds --no-sandbox when `unshare -Ur`
// fails). Slate then tells the user once, in Settings → Security and on the lock screen.
//
// Two facts decide it: the --no-sandbox switch on the real command line, and on Linux the renderers' own
// seccomp mode from /proc/<pid>/status (2 = seccomp-bpf, which every Chromium sandbox installs). The switch
// covers macOS and Windows; the probe also catches a renderer started unsandboxed some other way.

export type SandboxReason = 'no-sandbox-switch' | 'seccomp-off'
export interface SandboxVerdict {
  sandboxed: boolean
  reason: SandboxReason | null
}

export interface SandboxFacts {
  platform: NodeJS.Platform
  noSandboxSwitch: boolean
  /** Each live renderer's Seccomp mode; null where its status could not be read. */
  seccomp: ReadonlyArray<number | null>
}

/** The Seccomp mode from a /proc/<pid>/status text, or null without the line. */
export function parseSeccomp(status: string): number | null {
  const m = /^Seccomp:\s*(\d+)\s*$/m.exec(status)
  return m?.[1] === undefined ? null : Number(m[1])
}

export function sandboxVerdict(f: SandboxFacts): SandboxVerdict {
  if (f.noSandboxSwitch) return { sandboxed: false, reason: 'no-sandbox-switch' }
  // An unreadable status is no evidence: a renderer may exit between listing and reading.
  if (f.platform === 'linux' && f.seccomp.some((s) => s !== null && s !== 2)) return { sandboxed: false, reason: 'seccomp-off' }
  return { sandboxed: true, reason: null }
}

export interface SandboxMonitorDeps {
  platform: NodeJS.Platform
  hasNoSandboxSwitch: () => boolean
  readStatus: (path: string) => string
  /** The OS pids of the live renderers (`webContents.getOSProcessId()`); 0 means not started. */
  rendererPids: () => readonly number[]
  /** Called once, the first time a check finds no sandbox: the security event. */
  onUnsandboxed: (reason: SandboxReason) => void
}

export interface SandboxMonitor {
  /** Probes the live renderers now; once unsandboxed, the run stays unsandboxed. */
  check(): SandboxVerdict
}

export function createSandboxMonitor(d: SandboxMonitorDeps): SandboxMonitor {
  let latched: SandboxVerdict | null = null
  const seccompOf = (pid: number): number | null => {
    try {
      return parseSeccomp(d.readStatus(`/proc/${pid}/status`))
    } catch {
      return null
    }
  }
  return {
    check() {
      if (latched) return latched
      const seccomp = d.platform === 'linux' ? d.rendererPids().filter((p) => p > 0).map(seccompOf) : []
      const v = sandboxVerdict({ platform: d.platform, noSandboxSwitch: d.hasNoSandboxSwitch(), seccomp })
      if (v.sandboxed) return v
      latched = v
      if (v.reason) d.onUnsandboxed(v.reason)
      return v
    },
  }
}
