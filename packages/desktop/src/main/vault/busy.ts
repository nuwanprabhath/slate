export const BUSY_MESSAGE = 'Wait for the encryption in progress to finish'

/** §7.1: one vault change at a time; a migration in progress refuses every other (cancel included). */
export class VaultBusy {
  private active = false

  get running(): boolean {
    return this.active
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active) throw new Error(BUSY_MESSAGE)
    this.active = true
    try {
      return await work()
    } finally {
      this.active = false
    }
  }

  guard<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args) => {
      if (this.active) throw new Error(BUSY_MESSAGE)
      return fn(...args)
    }
  }
}
