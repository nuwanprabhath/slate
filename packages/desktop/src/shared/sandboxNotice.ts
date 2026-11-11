/**
 * POAM-16's one wording, in shared so main and the renderer say the same thing: the renderer that holds a
 * typed password is not isolated from the rest of the session. The renderer shows it as a notice; a
 * fips-140-3 vault refuses to unlock with it (vault/profile.ts).
 */
export const SANDBOX_NOTICE_TITLE = "Slate is running without Chromium's sandbox"

export const SANDBOX_NOTICE_BODY =
  'Its windows, the lock screen included, are not isolated from the rest of your session: other programs running as you can read their memory, ' +
  'such as a password you type to unlock. This is how the AppImage runs on most current Linux systems. Install the .deb package to run Slate in the sandbox.'

export const SANDBOX_LOCK_NOTE =
  "Running without Chromium's sandbox: other programs running as you can read what you type here. The .deb package runs sandboxed."

/** What a person on an AppImage with a FIPS 140-3 vault is told, on the lock screen and at every unlock attempt. */
export const SANDBOX_FIPS_REFUSAL =
  `This vault uses the FIPS 140-3 profile, and it will not unlock while Slate runs without Chromium's sandbox. ${SANDBOX_NOTICE_BODY}`
