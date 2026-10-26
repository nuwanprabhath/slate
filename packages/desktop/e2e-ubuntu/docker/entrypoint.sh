#!/bin/bash
# The bed idles until the harness starts an app (slate-run). Chromium only listens on loopback for
# DevTools, so socat carries the published port 9223 to the app's 9222.
set -eu
socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
exec sleep infinity
