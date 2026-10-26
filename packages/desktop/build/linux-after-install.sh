#!/bin/bash
# Runs as root after `apt install`. electron-builder fills in the ${...} names.

# POAM-16: every launch of the .deb runs Chromium's setuid sandbox, so the renderers (the lock screen's
# included) are sandboxed AND non-dumpable. --disable-namespace-sandbox must be on the real command line:
# the desktop entry gets it from deb.executableArgs, the `slate` command from this wrapper (a bare link
# would start the namespace sandbox wherever user namespaces are allowed, and that renderer is dumpable).
rm -f '/usr/bin/${executable}'
cat > '/usr/bin/${executable}' <<'WRAPPER'
#!/bin/sh
exec '/opt/${sanitizedProductName}/${executable}' --disable-namespace-sandbox "$@"
WRAPPER
chmod 755 '/usr/bin/${executable}'

# Without user namespaces Chromium's only sandbox is the setuid helper; a failure here must fail the install.
chown root:root '/opt/${sanitizedProductName}/chrome-sandbox'
chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'

if hash update-mime-database 2>/dev/null; then update-mime-database /usr/share/mime || true; fi
if hash update-desktop-database 2>/dev/null; then update-desktop-database /usr/share/applications || true; fi
