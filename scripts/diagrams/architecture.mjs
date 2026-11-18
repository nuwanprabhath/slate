// The README's architecture pictures (docs/architecture/img/*.svg). Edit one here, then run
// `node scripts/diagrams/architecture.mjs`.
import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { overflows, Svg } from './svg.mjs'

const OUT = fileURLToPath(new URL('../../docs/architecture/img', import.meta.url))
mkdirSync(OUT, { recursive: true })
const save = (name, svg) => writeFileSync(`${OUT}/${name}.svg`, svg.toString())

// 1. Overview: who owns what, and the one road between the window and the machine.
{
  const s = new Svg(880, 700, 'Slate overview: the renderer, preload, the main process, the cryptographic module and what they reach')
  s.group(20, 20, 840, 118, 'RENDERER · SANDBOXED, NO NODE, A CSP THAT ALLOWS NO NETWORK', 'ui')
  s.box(40, 50, 253, 68, 'Canvas and boxes', ['TipTap, bound to the CRDT'])
  s.box(313, 50, 254, 68, 'Sidebar and search', ['notebooks · sections · pages'])
  s.box(587, 50, 253, 68, 'Settings and dialogs', ['security · sync · AI access'])

  s.arrow([[440, 140], [440, 174]], { both: true })
  s.text(452, 162, 'asks for everything; nothing is reached directly')
  s.box(290, 174, 300, 58, 'preload: window.slate', ['the only bridge there is'])
  s.arrow([[440, 234], [440, 268]], { both: true })
  s.text(452, 256, 'one handler a channel, every argument checked, refused while locked')

  s.group(20, 268, 840, 232, 'MAIN PROCESS · OWNS EVERY FILE, KEY AND SOCKET', 'main')
  s.group(36, 300, 392, 182, 'Your notes', 'sub')
  s.box(48, 330, 184, 60, 'DocStore', ['CRDT updates, in SQLite'])
  s.box(242, 330, 174, 60, 'BlobStore', ['images on disk'])
  s.box(48, 402, 184, 60, 'MCP server', ['serves AI agents'])
  s.box(242, 402, 174, 60, 'SearchIndex', ['SQLite FTS5'])

  s.group(444, 300, 400, 182, 'Keys, sync and updates', 'sub')
  s.box(456, 330, 184, 60, 'Vault', ['unlock · lock · key ring'])
  s.box(650, 330, 182, 60, 'Sync engine', ['merge · seal · upload'])
  s.box(456, 402, 184, 60, 'Updater', ['both signatures verify'])
  s.box(650, 402, 182, 60, 'Self-test gate', ['before any key is used'])

  s.arrow([[440, 500], [440, 540]])
  s.text(452, 526, 'every key and every byte of cipher text')
  s.box(170, 540, 540, 62, '@slate/native — the cryptographic module', ['OpenSSL + FIPS Provider 3.1.2 · SQLCipher · keys in a secure heap'], 'box crypto')

  s.arrow([[250, 602], [250, 640]])
  s.arrow([[630, 602], [630, 640]])
  s.store(80, 640, 300, 56, 'This computer', ['encrypted database + images'])
  s.store(500, 640, 300, 56, 'Your git repository or OneDrive', ['sealed files under HMAC names'])

  s.box(20, 540, 130, 62, 'AI agent', ['bin/slate-mcp'], 'box out')
  s.arrow([[85, 540], [85, 466]], { dashed: true })
  s.text(20, 622, 'Over a local socket, and only', 'start')
  s.text(20, 639, 'the sections you shared.', 'start')
  save('overview', s)
}

// 2. Keys: three ways in, one master key, everything else derived.
{
  const s = new Svg(880, 440, 'Which key opens what: three unlock routes wrap one master key')
  s.text(40, 34, 'THREE WAYS IN', 'start', 'g')
  s.box(40, 50, 230, 62, 'Your password', ['Argon2id · PBKDF2 in FIPS'], 'box secret')
  s.box(40, 132, 230, 62, 'Recovery key', ['shown once, kept by you'], 'box secret')
  s.box(40, 214, 230, 62, 'Quick unlock', ['Touch ID or system keyring'], 'box secret')
  s.text(40, 300, 'Each wraps the same master key, so', 'start')
  s.text(40, 317, 'changing how you get in never', 'start')
  s.text(40, 334, 're-encrypts a single note.', 'start')

  s.arrow([[270, 81], [360, 150]])
  s.arrow([[270, 163], [360, 163]])
  s.arrow([[270, 245], [360, 176]])
  s.box(360, 132, 180, 62, 'Master key', ['random, all your devices'], 'box crypto')

  s.text(630, 34, 'WHAT THAT OPENS', 'start', 'g')
  s.arrow([[540, 150], [630, 76]])
  s.arrow([[540, 163], [630, 163]])
  s.arrow([[540, 176], [630, 250]])
  s.box(630, 46, 210, 60, 'Database key', ['opens SQLCipher here'], 'box crypto')
  s.box(630, 133, 210, 60, 'Sync key', ['a fresh key per remote file'], 'box crypto')
  s.box(630, 220, 210, 60, 'Name key', ['HMAC paths in the folder'], 'box crypto')

  s.text(630, 310, 'The database key is random per device', 'start')
  s.text(630, 327, 'and stored only wrapped, so joining', 'start')
  s.text(630, 344, 'another vault rewraps it instead of', 'start')
  s.text(630, 361, 're-encrypting the database.', 'start')

  s.text(440, 404, 'Rotating keys makes a new master key: that, and only that, re-encrypts everything.', 'middle')
  s.text(440, 426, 'Lose both the password and the recovery key and the notes are gone — nobody can recover them.', 'middle')
  save('keys', s)
}

// 3. Sync: what leaves this computer, and what the folder can still see.
{
  const s = new Svg(880, 430, 'How an edit reaches your other devices, and what the sync folder can see')
  s.box(40, 40, 180, 60, 'You type', ['in a box on a page'], 'box ui')
  s.arrow([[220, 70], [300, 70]])
  s.box(300, 40, 190, 60, 'A CRDT update', ['appended, never a rewrite'], 'box main')
  s.arrow([[490, 70], [570, 70]])
  s.box(570, 40, 270, 60, 'Stored and indexed', ['encrypted with the database key'], 'box main')

  s.arrow([[705, 100], [705, 150]])
  s.text(713, 130, 'later, on a sync run')
  s.box(530, 150, 310, 62, 'Sealed, one file at a time', ['fresh salt, so a fresh key, per file'], 'box crypto')
  s.arrow([[530, 181], [400, 181]])
  s.store(140, 150, 260, 62, 'Your git repo or OneDrive', ['e2ee/… under HMAC names'])
  s.arrow([[270, 212], [270, 262]])
  s.box(140, 262, 260, 60, 'Your other device', ['downloads, decrypts, merges'], 'box ui')

  s.group(440, 240, 400, 110, 'WHAT THE FOLDER STILL REVEALS', 'sub')
  s.text(456, 286, 'How many files there are, how big they are,', 'start')
  s.text(456, 303, 'and when they change. Not a note, a title, an', 'start')
  s.text(456, 320, 'image, a file name, or which page a file is.', 'start')

  s.text(40, 382, 'Two devices that changed the same page both append, and the data structure defines the merge:', 'start')
  s.text(40, 404, 'that is why editing offline works. A file that will not decrypt is an error, never read as plain text.', 'start')
  save('sync', s)
}

// 4. Start-up: the gate every user passes, encrypted or not.
{
  const s = new Svg(880, 430, 'Start-up: the power-up self-test gate, and the states a vault moves through')
  s.box(40, 40, 190, 64, 'Slate starts', ['module gated: no service'], 'box main')
  s.arrow([[230, 72], [288, 72]])
  s.box(290, 40, 200, 64, 'Power-up self-test', ['module hash pinned'], 'box crypto')

  // Success runs along the top and down the right; failure drops straight down and stops there.
  s.arrow([[490, 72], [558, 72]])
  s.text(524, 60, 'passes', 'middle')
  s.box(560, 40, 280, 64, 'Ready', ['plaintext, or locked'], 'box main')

  s.arrow([[390, 104], [390, 178]], { cls: 'stop' })
  s.text(398, 146, 'fails', 'start', 'stopt')
  s.box(290, 180, 200, 68, 'selftest-failed', ['terminal: nobody', 'gets in, ever'], 'box bad')

  s.arrow([[700, 104], [700, 178]])
  s.text(708, 146, 'you unlock')
  s.box(560, 180, 280, 64, 'Unlocked', ['keys live in the secure heap'], 'box crypto')

  s.arrow([[700, 244], [700, 308]])
  s.text(692, 282, 'idle · sleep · screen lock', 'end')
  s.box(560, 310, 280, 64, 'Keys wiped', ['back to locked'], 'box main')

  s.arrow([[560, 342], [530, 342], [530, 88], [558, 88]], { dashed: true })

  s.text(40, 300, 'A fips-140-3 vault latches the module', 'start')
  s.text(40, 317, 'approved-only before the first key, so', 'start')
  s.text(40, 334, 'Argon2id, HKDF and AES-ECB are', 'start')
  s.text(40, 351, 'unreachable for the rest of the run.', 'start')
  s.text(40, 404, 'The self-test runs before any key is used, every start, whether or not your notes are encrypted.', 'start')
  save('startup', s)
}

if (overflows.length) {
  console.error('Labels that may not fit:')
  for (const o of overflows) console.error(`  ${o}`)
  process.exitCode = 1
} else {
  console.log('All labels fit their boxes.')
}
