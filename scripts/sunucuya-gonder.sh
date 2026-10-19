#!/usr/bin/env bash
# Konuşgaç'ı bu bilgisayardan doğrudan bir sunucuya kurar ya da günceller; GitHub gerekmez.
#
#   scripts/sunucuya-gonder.sh <sunucu IP'si> <alan adı> [ssh anahtarı]
#   ör.  scripts/sunucuya-gonder.sh 203.0.113.10 konusgac.com ~/.ssh/konusgac_ed25519
#
# Gönderilen: son commit'teki kod (git archive) ve varsa packages/desktop/release içindeki Windows
# kurulum dosyası; o da sunucuda konusgac.com/indir adresinden indirilir ve güncellemeler oradan gelir.
# Sunucuda kur.sh çalışır (Docker, HTTPS, portlar). Sunucu Ubuntu/Debian olmalı, root ile bağlanılır.
set -euo pipefail

SUNUCU="${1:?Sunucunun IP adresini ver}"
ALAN="${2:?Alan adını ver (ör. konusgac.com)}"
ANAHTAR="${3:-$HOME/.ssh/konusgac_ed25519}"
KOK="$(cd "$(dirname "$0")/.." && pwd)"
SSH=(ssh -i "$ANAHTAR" -o StrictHostKeyChecking=accept-new "root@$SUNUCU")
SCP=(scp -i "$ANAHTAR" -o StrictHostKeyChecking=accept-new)

if [ -n "$(git -C "$KOK" status --porcelain)" ]; then
  echo "Uyarı: commit edilmemiş değişiklikler var; yalnızca son commit gönderilir." >&2
fi

ARSIV="$(mktemp -d)/konusgac.tgz"
git -C "$KOK" archive --format=tar.gz -o "$ARSIV" HEAD
echo "==> Kod gönderiliyor"
"${SCP[@]}" "$ARSIV" "root@$SUNUCU:/tmp/konusgac.tgz"
"${SCP[@]}" "$KOK/kur.sh" "root@$SUNUCU:/tmp/kur.sh"
"${SSH[@]}" "KONUSGAC_ARSIV=/tmp/konusgac.tgz bash /tmp/kur.sh '$ALAN'"

KURULUM="$KOK/packages/desktop/release"
if [ -f "$KURULUM/Konusgac-Kurulum.exe" ] && [ -f "$KURULUM/latest.yml" ]; then
  echo "==> Windows kurulum dosyası gönderiliyor"
  "${SSH[@]}" "mkdir -p /tmp/indir"
  "${SCP[@]}" "$KURULUM/Konusgac-Kurulum.exe" "$KURULUM/Konusgac-Kurulum.exe.blockmap" "$KURULUM/latest.yml" "root@$SUNUCU:/tmp/indir/"
  # latest.yml en son: güncelleyiciler yeni sürümü ancak dosyalar tamamken görür.
  "${SSH[@]}" "cd /opt/konusgac && docker compose exec -T -u root konusgac mkdir -p /data/indir \
    && docker compose cp /tmp/indir/Konusgac-Kurulum.exe konusgac:/data/indir/ \
    && docker compose cp /tmp/indir/Konusgac-Kurulum.exe.blockmap konusgac:/data/indir/ \
    && docker compose cp /tmp/indir/latest.yml konusgac:/data/indir/ \
    && docker compose exec -T -u root konusgac chown -R node:node /data/indir && rm -rf /tmp/indir"
else
  echo "(Kurulum dosyası yok; önce derle: scripts/kurulum-derle.sh)"
fi
echo
echo "Hazır: https://$ALAN   ·   Uygulama: https://$ALAN/indir"
