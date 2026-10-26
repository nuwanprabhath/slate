#!/bin/bash
# Starts one Slate build as `dev` under xvfb with DevTools on 127.0.0.1:9222, for the harness to drive.
#   slate-run <current|v010> <data folder> <keyring|locked-keyring|no-keyring>
# Further SLATE_* settings arrive through `docker exec -e`. The app's output goes to <data folder>.out.
set -eu
version=$1 data=$2 keyring=$3
case "$version" in current|v010) ;; *) echo "unknown build $version" >&2; exit 2 ;; esac
mkdir -p "$data"
export SLATE_USER_DATA="$data" SLATE_E2E=1 SLATE_E2E_SHOW=1
# --no-sandbox: Chromium's sandbox needs user namespaces Docker's seccomp profile denies; the app's own
# renderer sandbox flag (webPreferences) is unchanged.
# A laptop-sized screen: xvfb-run's default 640x480 is smaller than the app's window.
app=(xvfb-run -a -s '-screen 0 1600x1000x24' /app/$version/node_modules/.bin/electron /app/$version/packages/desktop --no-sandbox --disable-gpu --remote-debugging-port=9222)
if [ "$keyring" = locked-keyring ]; then
  # A desktop that logged in without the keyring password (auto-login): the daemon runs, the login
  # collection stays locked, and nothing can answer an unlock prompt.
  export XDG_CURRENT_DESKTOP=GNOME
  exec dbus-run-session -- bash -c 'gnome-keyring-daemon --start --components=secrets >/dev/null && exec "$@"' slate "${app[@]}" >"$data.out" 2>&1
elif [ "$keyring" = keyring ]; then
  # A desktop session: D-Bus, gnome-keyring's login collection unlocked, GNOME as the desktop, so
  # Electron's safeStorage picks gnome_libsecret as it would on Ubuntu's desktop.
  export XDG_CURRENT_DESKTOP=GNOME
  exec dbus-run-session -- bash -c 'printf %s "keyring-test" | gnome-keyring-daemon --unlock --components=secrets >/dev/null && exec "$@"' slate "${app[@]}" >"$data.out" 2>&1
else
  # No keyring: no D-Bus session, and safeStorage on basic_text, which Slate refuses for secrets.
  exec "${app[@]}" --password-store=basic >"$data.out" 2>&1
fi
