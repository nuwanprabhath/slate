/** Locks after `ms` without Slate input (§6.5); system idle is not used, it is unreliable under Wayland. */
export class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | undefined
  private ms = 0

  constructor(private readonly onIdle: () => void) {}

  /** 0 = never. */
  start(ms: number): void {
    this.ms = ms
    this.touch()
  }

  touch(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.ms <= 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.onIdle()
    }, this.ms)
  }

  stop(): void {
    this.ms = 0
    this.touch()
  }
}
