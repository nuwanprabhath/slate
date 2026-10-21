#!/bin/bash
# Runs as root after `apt install`. electron-builder fills in the ${...} names.

ln -sf '/opt/${sanitizedProductName}/${executable}' '/usr/bin/${executable}'

# Ubuntu 24.04 restricts unprivileged user namespaces, so Chromium's sandbox needs the setuid helper.
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox' || true

if hash update-mime-database 2>/dev/null; then update-mime-database /usr/share/mime || true; fi
if hash update-desktop-database 2>/dev/null; then update-desktop-database /usr/share/applications || true; fi
