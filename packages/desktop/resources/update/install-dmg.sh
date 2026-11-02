#!/bin/sh
# Install and restart on macOS: replaces the running Slate.app from a verified .dmg once Slate has quit
# (a running bundle must not be replaced). Run as the user when the bundle's folder is theirs, or as
# root by `sudo` when it is not, from this file in the app's own Resources: never from a file the user
# can rewrite while root waits (src/main/update/platformInstaller.ts decides, and checks).
#   $1 pid of Slate   $2 the .dmg   $3 its sha512 in hex, as the signed update feed names it
#   $4 the Slate.app to replace   $5 update-result.json under userData   $6 the version   $7 the user's uid
# Root copies the .dmg into a folder of its own and checks the copy before opening it; swaps the new
# bundle in beside the old one on the same volume, so a failure part way puts the old one back; clears
# the quarantine; deletes the .dmg only on success; writes its result as the user, for the next start;
# and opens Slate again as the user.
exec </dev/null
if [ "$(id -u)" -eq 0 ]; then PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; fi
pid=$1 dmg=$2 expected=$3 app=$4 result=$5 version=$6 uid=$7
case $version in *[!0-9A-Za-z.+-]*) version=unknown ;; esac
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
dmg_json=$(esc "$dmg")
parent=$(dirname "$app")
stage=""
old=""
work=""
mnt=""

relaunch() {
  if [ "$(id -u)" -eq 0 ]; then launchctl asuser "$uid" sudo -u "#$uid" open -n "$app"; else open -n "$app"; fi
}
report() {
  line=$(printf '{"version":"%s","ok":%s,"message":"%s","path":"%s"}' "$version" "$1" "$(esc "$2")" "$dmg_json")
  # As the user, so a link planted at the result path cannot make root write anywhere.
  if [ "$(id -u)" -eq 0 ]; then printf '%s\n' "$line" | sudo -u "#$uid" tee "$result" >/dev/null; else printf '%s\n' "$line" > "$result"; fi
}
unmount() { [ -n "$mnt" ] && { hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt"; rmdir "$mnt"; }; mnt=""; }
tidy() { [ -n "$stage" ] && rm -rf "$stage"; unmount; [ -n "$work" ] && rm -rf "$work"; }
fail() { tidy; report false "$1"; relaunch; exit 1; }

i=0
while kill -0 "$pid" 2>/dev/null; do
  i=$((i+1)); [ "$i" -ge 300 ] && { report false "Slate did not quit in time, so the update was not installed."; exit 1; }
  sleep 0.2
done

work=$(mktemp -d) || fail "Could not make a folder to check the disk image in."
cp "$dmg" "$work/Slate.dmg" || fail "The disk image could not be read."
if command -v sha512sum >/dev/null 2>&1; then sum=$(sha512sum "$work/Slate.dmg"); else sum=$(shasum -a 512 "$work/Slate.dmg"); fi
[ "${sum%% *}" = "$expected" ] || fail "The downloaded file changed since it was verified, so it was not installed."

mnt=$(mktemp -d) || fail "Could not make a folder to open the disk image in."
hdiutil attach -nobrowse -quiet -noverify -mountpoint "$mnt" "$work/Slate.dmg" || { rmdir "$mnt"; mnt=""; fail "The disk image could not be opened."; }
new=""
for a in "$mnt"/*.app; do [ -d "$a" ] && { new=$a; break; }; done
[ -n "$new" ] || fail "The disk image holds no app."
stage=$(mktemp -d "$parent/.slate-update-XXXXXX") || fail "Could not make room for the new version next to the old one."
old="$stage.old"
ditto "$new" "$stage" || fail "The new version could not be copied out of the disk image."
chmod 755 "$stage"
unmount
mv "$app" "$old" || fail "The installed version could not be moved aside."
if ! mv "$stage" "$app"; then
  mv "$old" "$app" || { tidy; report false "The new version could not be installed and the old one could not be put back: it is at $(basename "$old")."; exit 1; }
  fail "The new version could not be moved into place."
fi
stage=""
rm -rf "$old"
xattr -cr "$app"
rm -f "$dmg"
tidy
report true ""
relaunch
