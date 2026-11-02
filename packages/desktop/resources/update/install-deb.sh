#!/bin/sh
# Install and restart on Ubuntu. Run as root by `sudo` (src/main/update/platformInstaller.ts), from the
# root-owned /opt/Slate/resources/update: a file the user can rewrite is never what root runs.
#   $1  the verified .deb (in the user's Downloads, which any process of the account can write)
#   $2  the sha512, in hex, that the signed update feed names for it
# Root copies the .deb into a folder only it can write, checks the copy, and installs the copy, so a
# swap after Slate's own check changes nothing. apt's exit status is this script's.
exec </dev/null
if [ "$(id -u)" -eq 0 ]; then PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH; fi
work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
cp "$1" "$work/slate.deb" || { echo "The downloaded file could not be read." >&2; exit 1; }
if command -v sha512sum >/dev/null 2>&1; then sum=$(sha512sum "$work/slate.deb"); else sum=$(shasum -a 512 "$work/slate.deb"); fi
[ "${sum%% *}" = "$2" ] || { echo "The downloaded file changed since it was verified, so it was not installed." >&2; exit 1; }
DEBIAN_FRONTEND=noninteractive apt-get install -y --allow-downgrades "$work/slate.deb"
