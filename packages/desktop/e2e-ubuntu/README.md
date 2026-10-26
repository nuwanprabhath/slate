# Cross-device harness: Mac + Ubuntu 24.04

Two computers on one git notes repository: the **Mac** is this machine (Playwright's Electron launcher,
`SLATE_E2E=1`, hidden windows), **Ubuntu** is a Docker container running the app under xvfb. The scenarios
live in `crossDevice.spec.ts`.

## Run

```sh
npm run e2e:ubuntu                                   # every scenario (builds the Mac app first)
npm run e2e:ubuntu -- -g "mixed versions"            # one scenario, by part of its title
cd packages/desktop && npx playwright test --config e2e-ubuntu/playwright.config.ts -g "v1 vault"   # skip the Mac build
```

Docker must be running. The first run takes ~10 minutes: it builds the image (`docker/Dockerfile`, ~3.6 GB)
and installs and builds v0.1.0 for the Mac once, under `.tools/e2e-ubuntu/` (gitignored). Later runs reuse
Docker's layer cache, so a source change rebuilds only the last layers (~1 minute). The run refuses to start
with less than 8 GiB free (`diskGuard.ts`).

`SLATE_UBUNTU_PLATFORM=linux/amd64` builds the x64 image instead of the host's architecture (emulated on
Apple silicon, so slow).

## How it works

- `globalSetup.ts` removes containers a killed run left, builds what is missing (`bed.ts`), and starts one
  container for the run with a host temp folder mounted at `/remote`. Teardown removes both.
- Each scenario gets `<shared>/<scenario>/notes.git`, a bare repository. The Mac uses it as
  `file://<shared>/...`; Ubuntu through a link, `file:///home/dev/links/<scenario>.git`, which
  `setOnline(false)` removes to take the repository away while the app runs.
- `docker/slate-run.sh` starts a build (`current` = this tree, `v010` = the v0.1.0 tag) as `dev` with DevTools
  on port 9222; the container's socat publishes it to `127.0.0.1:<random port>` on the Mac, and `devices.ts`
  drives it with `chromium.connectOverCDP`. Keyring modes: `keyring` (D-Bus session, gnome-keyring's login
  collection unlocked, so safeStorage uses `gnome_libsecret`), `locked-keyring` (auto-login desktop) and
  `no-keyring` (`--password-store=basic`).
- `@slate/native` is built in the image for `linux-arm64` (or `linux-x64`), libcrypto + SQLCipher, no FIPS
  provider, as in CI's Linux job.
- Nothing touches your data folder, Keychain or GitHub: every data folder is a temp folder or lives in the
  container, and quick unlock is exercised only on Ubuntu's gnome-keyring.

## Debug

- `SLATE_XDEV_KEEP=1` keeps the container and the shared folder after the run and prints their names.
- A shell in the container: `docker exec -it <container> bash`. Ubuntu's data folders are
  `/home/dev/xdev/<scenario>-<repeat>-<retry>`, each app's stdout/stderr is the same path plus `.out`.
- Start an app by hand: `docker exec -d -e SLATE_TEST_WEAK_KDF=1 <container> slate-run current /home/dev/try keyring`,
  then open `http://127.0.0.1:<port>/json` or connect Chrome's DevTools to the published port
  (`docker port <container> 9223`).
- A failed scenario prints the tail of Ubuntu's app output and saves a screenshot of every open window
  of both devices in its `test-results/` folder.
- Repeat a flaky scenario: `-g "<title>" --repeat-each 5` (each attempt gets fresh folders).
- Leftovers: `docker ps -a --filter label=slate.test-bed=e2e-ubuntu`; the image is `slate-e2e-ubuntu`.
