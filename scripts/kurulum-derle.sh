#!/usr/bin/env bash
# Windows kurulum dosyasını Docker içinde (Linux + wine) derler: packages/desktop/release/
# Windows'un uygulama denetimi imzasız yeni dosyaları çalıştırmayı engellediğinde de çalışır.
set -euo pipefail
MASAUSTU="$(cd "$(dirname "$0")/../packages/desktop" && pwd)"
rm -rf "$MASAUSTU/release" && mkdir -p "$MASAUSTU/release"
yol() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
MSYS_NO_PATHCONV=1 docker run --rm \
  -v "$(yol "$MASAUSTU")":/src:ro -v "$(yol "$MASAUSTU/release")":/out \
  -e ELECTRON_SKIP_BINARY_DOWNLOAD=1 electronuserland/builder:wine \
  bash -c "cp -r /src /build && rm -rf /build/release /build/node_modules && cd /build \
    && npm install --no-audit --no-fund --loglevel=error >/dev/null \
    && npx electron-builder --win nsis --publish never \
    && cp release/Konusgac-Kurulum.exe release/Konusgac-Kurulum.exe.blockmap release/latest.yml /out/"
ls -la "$MASAUSTU/release"
