#!/bin/bash
# Runs as root after `apt remove`. The after-install wrote /usr/bin/${executable} as a wrapper script.
rm -f '/usr/bin/${executable}'
