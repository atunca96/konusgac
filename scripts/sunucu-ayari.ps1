# Sunucunun gizli ayarlarını (Resend ve Google anahtarları) bu bilgisayardan girer.
# Değer ekranda görünmez; doğrudan sunucuya, /opt/konusgac/.env dosyasına yazılır ve Konuşgaç
# yeniden başlatılır. Hiçbir yere kaydedilmez, kimseyle paylaşılmaz.
#
#   powershell -ExecutionPolicy Bypass -File scripts\sunucu-ayari.ps1
param(
  [string]$Sunucu = '136.144.230.214',
  [string]$Anahtar = "$env:USERPROFILE\.ssh\konusgac_ed25519"
)

# Türkçe karakterler (ör. "Konuşgaç <noreply@...>") sunucuya bozulmadan, BOM'suz UTF-8 olarak gitsin.
$OutputEncoding = New-Object System.Text.UTF8Encoding $false

$ayarlar = [ordered]@{
  '1' = @('RESEND_API_KEY', 'Resend API anahtarı (re_ ile başlar)')
  '2' = @('GOOGLE_CLIENT_ID', 'Google istemci kimliği (...apps.googleusercontent.com)')
  '3' = @('GOOGLE_CLIENT_SECRET', 'Google istemci gizli anahtarı (GOCSPX- ile başlar)')
  '4' = @('KONUSGAC_MAIL_FROM', 'Gönderen adresi (ör. Konuşgaç <noreply@konusgac.com>)')
  '5' = @('KONUSGAC_ISLETEN', 'Sunucuyu işleten kişi ya da kurum (Koşullar ve KVKK metninde görünür)')
  '6' = @('KONUSGAC_ILETISIM', 'İletişim e-postası (Koşullar ve KVKK metninde görünür)')
  '7' = @('KONUSGAC_YONETICILER', 'Platform yöneticileri: kullanıcı adları, virgülle (ör. alper)')
}

while ($true) {
  Write-Host ''
  foreach ($k in $ayarlar.Keys) { Write-Host "  $k) $($ayarlar[$k][1])" }
  Write-Host '  q) Bitir'
  $secim = Read-Host 'Hangisini gireceksin'
  if ($secim -eq 'q') { break }
  if (-not $ayarlar.Contains($secim)) { continue }
  $ad = $ayarlar[$secim][0]
  $gizli = Read-Host "$ad değeri" -AsSecureString
  $deger = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($gizli)).Trim()
  if (-not $deger) { Write-Host 'Boş bırakıldı, değişmedi.'; continue }
  # Değer komut satırında değil, girdi olarak gider; sunucudaki scripts/ayar-yaz.sh onu .env'e yazar.
  $deger | ssh -i $Anahtar "root@$Sunucu" "bash /opt/konusgac/scripts/ayar-yaz.sh $ad"
}

Write-Host 'Konuşgaç yeniden başlatılıyor...'
ssh -i $Anahtar "root@$Sunucu" "cd /opt/konusgac && docker compose up -d >/dev/null 2>&1 && echo Hazır."
