#!/usr/bin/env bash
# Konuşgaç sunucusunu tek komutla kurar ya da günceller (Ubuntu / Debian):
#
#   curl -fsSL https://raw.githubusercontent.com/atunca96/konusgac/main/kur.sh | sudo bash -s -- konusgac.ornek.org
#
# Önce alan adının DNS kaydını (A) bu sunucunun IP adresine yönlendir. Betik Docker'ı kurar,
# Konuşgaç'ı /opt/konusgac altına indirir, gerekli portları açar ve HTTPS ile başlatır.
# Aynı komutu sonra tekrar çalıştırmak Konuşgaç'ı en yeni sürüme günceller; veriler korunur.
set -euo pipefail

ALAN="${1:-}"
DIZIN=/opt/konusgac

if [ "$(id -u)" -ne 0 ]; then
  echo "Bu betik yönetici olarak çalışmalı: komutun başına sudo ekle." >&2
  exit 1
fi
if [ -z "$ALAN" ] && [ -f "$DIZIN/.env" ]; then
  ALAN="$(sed -n 's/^KONUSGAC_ALAN_ADI=//p' "$DIZIN/.env")"
fi
if [ -z "$ALAN" ]; then
  read -rp "Alan adı (ör. konusgac.ornek.org): " ALAN </dev/tty
fi
case "$ALAN" in
  *.*) ;;
  *) echo "Geçerli bir alan adı gerekli (ör. konusgac.ornek.org)." >&2; exit 1 ;;
esac

echo "==> Gerekli araçlar"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
if ! command -v git >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y -qq git
fi

# KONUSGAC_ARSIV: kod GitHub yerine bir arşivden gelir (scripts/sunucuya-gonder.sh bunu kullanır).
if [ -n "${KONUSGAC_ARSIV:-}" ]; then
  echo "==> Konuşgaç arşivden açılıyor ($DIZIN)"
  mkdir -p "$DIZIN"
  tar -xzf "$KONUSGAC_ARSIV" -C "$DIZIN"
elif [ -d "$DIZIN/.git" ]; then
  echo "==> Konuşgaç güncelleniyor ($DIZIN)"
  git -C "$DIZIN" pull --ff-only
else
  echo "==> Konuşgaç indiriliyor ($DIZIN)"
  git clone --depth 1 https://github.com/atunca96/konusgac.git "$DIZIN"
fi
cd "$DIZIN"
# .env: yalnızca betiğin kendi satırları değişir; sonradan eklenen anahtarlar (Resend, Google) korunur.
ayarla() {
  touch .env
  grep -v "^$1=" .env > .env.yeni || true
  printf '%s=%s\n' "$1" "$2" >> .env.yeni
  mv .env.yeni .env
  chmod 600 .env
}
ayarla KONUSGAC_ALAN_ADI "$ALAN"
# Ses ve görüntünün ilan edilen adresi: sunucunun genel IP'si (DNS henüz yayılmamış olsa da doğru çalışır).
# Makine bir NAT arkasındaysa (özel IP) alan adı kullanılır.
IP="$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')"
case "$IP" in
  ""|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
  *) ayarla KONUSGAC_RTC_ADDRESS "$IP" ;;
esac

echo "==> Güvenlik duvarı"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 40000
fi

echo "==> Başlatılıyor"
# Hazır imaj varsa indirilir; yoksa (ya da kod arşivden geldiyse) bu klasörden derlenir.
if [ -n "${KONUSGAC_ARSIV:-}" ] || ! docker compose pull konusgac 2>/dev/null; then
  docker compose build konusgac
fi
docker compose up -d

echo
echo "Konuşgaç hazır: https://$ALAN"
echo "(HTTPS sertifikası ilk açılışta birkaç saniye içinde alınır.)"
echo "Bulut sağlayıcının kendi güvenlik duvarı varsa 80, 443 (TCP) ve 40000 (UDP ve TCP) portlarını orada da aç."
