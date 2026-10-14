#!/bin/bash
# Builds the package a new client's server is installed from:
#   dist/viztex-<date>-<commit>.tgz
# containing install/ (install.sh, add-trunk.sh) and app/ (what runs on the
# server: backend code, built web app, migrations, ops scripts, Asterisk
# dialplan files). Never .env, certs, logs or node_modules.
#
# Usage (from the repo root, Git Bash):  bash scripts/make-release.sh
#   SKIP_CHECKS=1  skip lint / tests (not for a real client)
# Then:  scp -i <key>.pem dist/viztex-*.tgz ubuntu@<server>:~
#        ssh ...  tar xzf viztex-*.tgz && sudo bash viztex/install/install.sh --domain ... --admin ...
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n== %s\n' "$*"; }

if [ -n "$(git status --porcelain)" ]; then
  echo "Uncommitted changes - commit first, so the package matches a commit." >&2
  [ "${ALLOW_DIRTY:-}" = 1 ] || exit 1
fi

if [ "${SKIP_CHECKS:-}" != 1 ]; then
  step "Checks (lint, format, typecheck, tests)"
  npm run check --silent
fi

step "Build web app"
npm run build:web --silent

VERSION="$(date -u +%Y%m%d)-$(git rev-parse --short HEAD)"
STAGE="$(mktemp -d)/viztex"
mkdir -p "$STAGE/app" dist

step "Stage $VERSION"
cp -r install "$STAGE/install"
(cd backend && cp -r server.js dialer-engine.js dialer-common.js call-control.js ari.js ami.js db.js \
  package.json package-lock.json .env.example src migrations ops asterisk web-dist "$STAGE/app/")
echo "$VERSION" > "$STAGE/VERSION"
# Line endings: the server runs these with bash.
find "$STAGE" -name '*.sh' -exec sed -i 's/\r$//' {} +

PKG="dist/viztex-$VERSION.tgz"
tar czf "$PKG" -C "$(dirname "$STAGE")" viztex
rm -rf "$(dirname "$STAGE")"
echo "package: $PKG ($(du -h "$PKG" | cut -f1))"
echo
echo "Next:"
echo "  scp -i <key>.pem $PKG ubuntu@<server>:~"
echo "  ssh -i <key>.pem ubuntu@<server>"
echo "  tar xzf $(basename "$PKG") && sudo bash viztex/install/install.sh --domain <host> --admin <username> --email <you@company>"
