# The Ubuntu 24.04 device of the cross-device harness (packages/desktop/e2e-ubuntu): Node 22, xvfb, the
# libraries Electron needs, gnome-keyring on a D-Bus session for safeStorage, git, and two builds of Slate:
# /app/v010 (the v0.1.0 tag) and /app/current (this tree). Built by e2e-ubuntu/bed.ts from the repo root:
#   docker build --build-context v010=<v0.1.0 source> -f packages/desktop/e2e-ubuntu/docker/Dockerfile .
# Native on the host's architecture (arm64 on Apple silicon); `--platform linux/amd64` builds the x64 one.
FROM ubuntu:24.04
LABEL slate.test-bed=e2e-ubuntu
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git sudo procps socat perl python3 build-essential pkg-config \
    xvfb xauth dbus dbus-x11 gnome-keyring libsecret-1-0 libsecret-tools \
    libgtk-3-0t64 libnss3 libasound2t64 libxss1 libgbm1 libxtst6 libatk-bridge2.0-0t64 libdrm2 libxshmfence1 \
    libxkbcommon0 libcups2t64 libxcomposite1 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && rm -rf /var/lib/apt/lists/*

# The base image's uid 1000 makes way for `dev`, who runs the app. The sync remote is a bind mount
# owned by the host user, which git would otherwise refuse as "dubious ownership".
RUN (userdel -r ubuntu || true) && useradd -m -s /bin/bash -u 1000 dev \
 && git config --system --add safe.directory '*'

# v0.1.0 first: its source never changes, so this layer is built once. Its postinstall rebuilds
# better-sqlite3 for Electron.
COPY --from=v010 . /app/v010
WORKDIR /app/v010
RUN npm ci --no-audit --no-fund && node node_modules/electron/install.js \
 && npm run -w @slate/desktop build && rm -rf /root/.cache /root/.npm /root/.electron-gyp

# The current tree: dependencies, then @slate/native (OpenSSL libcrypto + SQLCipher; no FIPS provider,
# as in CI's Linux job), then the source. Each layer is reused until what it copies changes.
WORKDIR /app/current
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/editor/package.json packages/editor/
COPY packages/desktop/package.json packages/desktop/
COPY packages/importer/package.json packages/importer/
COPY packages/mcp/package.json packages/mcp/
COPY packages/native/package.json packages/native/
COPY packages/sync/package.json packages/sync/
RUN npm ci --ignore-scripts --no-audit --no-fund && node node_modules/electron/install.js \
 && rm -rf /root/.npm

COPY packages/native packages/native
RUN npm run -w @slate/native build:openssl -- --only openssl \
 && npm run -w @slate/native build:sqlcipher \
 && npm run -w @slate/native build:addon \
 && rm -rf packages/native/.build/downloads packages/native/.build/linux-* packages/native/build /root/.cache /root/.electron-gyp

COPY . .
RUN npm run -w @slate/desktop build

COPY packages/desktop/e2e-ubuntu/docker/slate-run.sh /usr/local/bin/slate-run
COPY packages/desktop/e2e-ubuntu/docker/entrypoint.sh /usr/local/bin/slate-bed
RUN chmod 755 /usr/local/bin/slate-run /usr/local/bin/slate-bed
USER dev
WORKDIR /home/dev
ENTRYPOINT ["/usr/local/bin/slate-bed"]
