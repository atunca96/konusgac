# Kendi Konuşgaç sunucunu kurmak

Bu rehber Konuşgaç'ı internete açık, HTTPS'li bir sunucuda çalıştırmayı anlatır.
Bir arkadaş grubu için küçük bir sanal sunucu (1 çekirdek, 1 GB bellek) yeterlidir.

## 1. Tek komutla (önerilen)

Gereken: Ubuntu ya da Debian kurulu bir sunucu ve bir alan adı.

1. Alan adının DNS kaydını (A) sunucunun IP adresine yönlendir.
2. Sunucuda çalıştır:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/atunca96/konusgac/main/kur.sh | sudo bash -s -- konusgac.ornek.org
   ```

Betik Docker'ı kurar, Konuşgaç'ı `/opt/konusgac` altına indirir, güvenlik duvarında (ufw) gereken portları açar ve
HTTPS ile başlatır. Birkaç dakika içinde `https://konusgac.ornek.org` adresinde Konuşgaç açılır.
Bulut sağlayıcının ayrıca kendi güvenlik duvarı varsa (Hetzner, AWS, Oracle...) şu portları orada da aç:

| Port | Ne için |
| --- | --- |
| 80, 443 (TCP) | Web sitesi ve HTTPS sertifikası |
| 40000 (UDP ve TCP) | Ses, kamera ve ekran paylaşımı |

Güncellemek için aynı komutu yeniden çalıştır. Veriler `veri` adlı Docker biriminde (`/data`) durur:
veritabanı (`konusgac.db`) ve dosya ekleri (`attachments/`).

Elle kurmak istersen betiğin yaptığı da şudur:

```bash
git clone https://github.com/atunca96/konusgac.git /opt/konusgac && cd /opt/konusgac
echo "KONUSGAC_ALAN_ADI=konusgac.ornek.org" > .env
docker compose up -d
```

### Kendi bilgisayarından göndermek (GitHub olmadan)

Kodu ve Windows kurulum dosyasını bu bilgisayardan doğrudan sunucuya kurar; sunucuya root olarak SSH anahtarıyla
bağlanılabilmesi yeter:

```bash
scripts/kurulum-derle.sh                                   # Windows kurulum dosyası (Docker içinde)
scripts/sunucuya-gonder.sh 203.0.113.10 konusgac.ornek.org  # sunucuya kur ya da güncelle
```

Kurulum dosyası sunucuda `https://konusgac.ornek.org/indir` adresinden indirilir; kurulu uygulamalar
güncellemeleri de buradan alır (`latest.yml`).

## 2. Docker olmadan

Gereken: Node.js 22.19+ veya 24.11+.

```bash
npm install
npm run build
HOST=0.0.0.0 PORT=3001 KONUSGAC_DB=/var/lib/konusgac/konusgac.db npm start
```

Ses ve görüntü için 40000 numaralı portu (UDP ve TCP) aç ve sunucunun dışarıdan görünen adresini
`KONUSGAC_RTC_ADDRESS` ile ver (IP ya da alan adı). Önüne HTTPS sağlayan bir ters vekil koy (Caddy, nginx) ve
`TRUST_PROXY=1` ver. Caddy için tek satır yeter:

```
konusgac.ornek.org {
  reverse_proxy 127.0.0.1:3001
}
```

Sesli sohbet için tarayıcılar mikrofona yalnızca HTTPS sayfalarda (ya da `localhost`'ta) izin verir. Bu yüzden
internete açık bir sunucuda HTTPS şarttır.

## Ayarlar (ortam değişkenleri)

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `PORT` | `3001` | Dinlenecek port |
| `HOST` | `127.0.0.1` | Dinlenecek adres; dışarıya açmak için `0.0.0.0` |
| `KONUSGAC_DB` | `data/konusgac.db` | Veritabanı dosyası; dosya ekleri aynı klasörde `attachments/` altında durur |
| `KONUSGAC_REGISTRATION` | `open` | `closed`: yeni hesap açılamaz (mevcut kullanıcılar etkilenmez) |
| `KONUSGAC_MAX_UPLOAD_MB` | `10` | Dosya başına en büyük boyut (MB) |
| `KONUSGAC_RTC_PORT` | `40000` | Ses ve görüntünün geçtiği port (UDP ve TCP) |
| `KONUSGAC_RTC_ADDRESS` | makinenin kendi IP'si | İstemcilerin ses portuna ulaştığı adres: sunucunun genel IP'si ya da alan adı (Docker'da `KONUSGAC_ALAN_ADI` kullanılır) |
| `KONUSGAC_YONETICILER` | boş | Platform yöneticilerinin kullanıcı adları (virgülle). Şikâyetleri görür, her içeriği kaldırır, hesapları kapatır (Ayarlar → Platform yönetimi) |
| `KONUSGAC_ISLETEN`, `KONUSGAC_ILETISIM` | boş | Kullanım Koşulları ve KVKK metninde görünen işleten ve iletişim adresi |
| `TRUST_PROXY` | kapalı | `1`: ters vekilin ardındasın; istemci IP'si `X-Forwarded-For`'dan alınır (hız sınırları için önemli) |

## Ses ve görüntü nasıl akar

Her şey sunucu üzerinden geçer: herkes sesini, kamerasını ve ekranını bir kez sunucuya gönderir,
sunucu kanaldaki diğerlerine dağıtır. Böylece oda büyüdükçe kimsenin yükleme hızı yetmez hale gelmez ve ayrı bir
TURN sunucusuna gerek kalmaz: UDP'yi engelleyen okul, şirket ya da mobil ağlarda bağlantı aynı portun TCP'si
üzerinden kurulur.

Sunucuda asıl harcanan bant genişliğidir: bir kişinin sesi dinleyen her kişi için ~40 kbit/s, 1080p 30 FPS bir
yayın onu izleyen her kişi için ~4,5 Mbit/s çıkış demektir. Kimse izlemiyorsa yayın sunucudan dışarı hiç akmaz.

## Yedekleme

Her şey veri klasöründedir. Çalışırken tutarlı bir kopya almak için:

```bash
docker compose exec konusgac node -e "new (require('node:sqlite').DatabaseSync)('/data/konusgac.db').exec(\"VACUUM INTO '/data/yedek.db'\")"
docker compose cp konusgac:/data ./konusgac-yedek
```

Docker olmadan: `sqlite3 konusgac.db ".backup yedek.db"` ve `attachments/` klasörünü kopyala.

## Güncelleme

```bash
curl -fsSL https://raw.githubusercontent.com/atunca96/konusgac/main/kur.sh | sudo bash -s -- konusgac.ornek.org
```

(ya da `/opt/konusgac` içinde `git pull && docker compose pull && docker compose up -d`)

Veritabanı şeması açılışta otomatik olarak yeni sürüme taşınır. Güncellemeden önce yedek almak iyi bir alışkanlıktır.

## Güvenlik notları

- Hız sınırları açıktır: giriş denemeleri, kayıt, mesaj, dosya, tepki ve gateway bağlantıları sınırlıdır.
  Ters vekil kullanıyorsan `TRUST_PROXY=1` vermezsen tüm kullanıcılar aynı IP'den geliyor görünür ve sınırlara erken takılır.
- Kayıtları açık bırakmak istemiyorsan önce kendi hesaplarınızı açın, sonra `KONUSGAC_REGISTRATION=closed` ver.
- Güvenlik açığı bildirimleri için: [SECURITY.md](../SECURITY.md).
