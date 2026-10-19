#!/usr/bin/env bash
# Sunucuda çalışır: bir gizli ayarı /opt/konusgac/.env içine yazar. Ad argümandır (yalnızca bilinen
# adlar), değer girdiden okunur; böylece değer hiçbir komut satırında görünmez.
# scripts/sunucu-ayari.ps1 bunu kullanır.
set -euo pipefail
ad="${1:-}"
case "$ad" in
  RESEND_API_KEY | GOOGLE_CLIENT_ID | GOOGLE_CLIENT_SECRET | KONUSGAC_MAIL_FROM | KONUSGAC_ISLETEN | KONUSGAC_ILETISIM | KONUSGAC_YONETICILER) ;;
  *) echo "Bilinmeyen ayar: $ad" >&2; exit 1 ;;
esac
IFS= read -r v || true
v="${v#$'\xEF\xBB\xBF'}" # Windows'un eklediği BOM
v="${v%$'\r'}"
cd /opt/konusgac
touch .env
grep -v "^$ad=" .env > .env.yeni || true
printf '%s=%s\n' "$ad" "$v" >> .env.yeni
mv .env.yeni .env
chmod 600 .env
echo "$ad kaydedildi."
