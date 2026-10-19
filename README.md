# Konuşgaç

> Discord hala kapalı. Arkadaşlarımızla konuşmak için ne olduğunu anlamadığımız ayarlar yapmak istemiyoruz, tuhaf programlar da indirmek istemiyoruz. Tam bu yüzden Konuşgaç'ı yaptım. Tamamen açık kaynaklı.

### [⬇ Konuşgaç'ı indir (Windows)](https://konusgac.com/indir)

Web sitesi: [konusgac.com](https://konusgac.com)

**Ücretsiz ve açık kaynaklı, kendi sunucunda çalışan sohbet uygulaması.**
Sunucular, kanallar, sesli sohbet, özel mesajlar, roller; tarayıcıda ve Windows masaüstü uygulaması olarak.

- **Tamamen ücretsiz.** Abonelik, ücretli seviye ya da "premium" özellik yok, olmayacak.
- **Kendi sunucunda.** Bir arkadaş grubu, okul kulübü ya da topluluk kendi Konuşgaç'ını birkaç komutla kurar.
  Veriler tek bir SQLite dosyasında, senin makinende durur.
- **Açık kaynak (AGPL-3.0).** Kodu herkes okuyabilir, değiştirebilir, kendi sunucusunda çalıştırabilir.
  Değiştirilmiş bir sürümü internette hizmet olarak sunan da kodunu açmak zorundadır, böylece proje hep açık kalır.
- **Türkçe.** Arayüz baştan Türkçe yazıldı; arama Türkçe büyük/küçük harf kurallarını bilir (İ/i, I/ı).

## Özellikler (v0.9)

| | |
| --- | --- |
| **Sunucular** | Kategoriler, metin ve ses kanalları, davet bağlantıları, sunucu sahipliğini devretme |
| **Mesajlaşma** | Canlı mesajlar, düzenleme ve silme, yanıtlar, emoji tepkileri, `@kullanıcı` ve `@everyone` bahsetmeleri, "yazıyor…" göstergesi |
| **Dosyalar** | Sürükle-bırak, yapıştır ya da seç; resim ve videolar sohbette açılır (varsayılan sınır dosya başına 10 MB) |
| **Okunmamışlar** | Kanallarda okunmamış işareti ve bahsetme sayacı; tüm cihazlarda eşit, sunucuda saklanır |
| **Arama** | Sunucu ya da özel mesajlar içinde arama |
| **Sesli sohbet** | Sunucu üzerinden (SFU): herkes sesini bir kez gönderir, oda büyüse de bağlantı yükü artmaz; susturma, sağırlaştırma, konuşanı gösterme |
| **Kamera ve yayın** | Sesli kanalda kamera açma ve ekran paylaşımı (720p/1080p/kaynak, 15/30/60 FPS, Windows'ta bilgisayarın sesiyle); masaüstü uygulamasında ekran ya da pencere seçici; karolu arama ekranı, odaklama ve tam ekran |
| **Roller ve izinler** | Rol hiyerarşisi, sunucu ve kanal bazında izin verme/engelleme, gizli kanallar |
| **Arkadaşlar** | Arkadaşlık istekleri, birebir özel mesajlar, çevrimiçi durumu, masaüstü bildirimleri |
| **Ayarlar** | Tam ekran ayarlar: ses ve görüntü (giriş/çıkış cihazı, ses düzeyleri, mikrofon testi, ses etkinliği ya da bas-konuş, otomatik/elle hassasiyet, yankı/gürültü bastırma, profiller, kamera önizleme), kişi başına ses düzeyi, bildirim sesleri, tuş atamaları, görünüm (koyu/daha koyu/açık tema, kompakt mod, yazı boyutu, yakınlaştırma), erişilebilirlik, gizlilik, cihazlar (oturumlar), yayıncı modu, Windows ayarları, geliştirici modu |
| **Giriş** | Kullanıcı adı ya da e-postayla giriş, **Google ile devam et**, e-posta doğrulama, "Şifremi unuttum" (Resend ile e-posta) |
| **Sağ tık menüleri** | Her yerde: mesajlar (hızlı tepki, düzenle, yanıtla, kopyala, okunmadı işaretle, bağlantı), kişiler (bahset, mesaj, arkadaşlık, roller, at, ses düzeyi), kanallar, kategoriler, sunucular; masaüstünde metin kutuları için yazım önerili menü |
| **Moderasyon** | Mesaj şikâyeti (kanıt kopyasıyla, yöneticiye e-posta), sunucudan yasaklama, platform yönetimi: şikâyetler, her içeriği kaldırma, hesap kapatma |
| **Hesap** | Şifre değiştirme (diğer cihazlardan çıkış), hesabı ve kişisel verileri silme (KVKK) |
| **Güvenlik** | Hız sınırları, kaba kuvvet koruması, güvenlik başlıkları, izinlerin her zaman sunucuda denetlenmesi |

## Kullanmaya başla

### Bir sunucuya bağlanmak (kullanıcılar)

1. **[Konusgac-Kurulum.exe](https://konusgac.com/indir)** dosyasını indir ve çift tıkla. Kurulum soru sormadan biter ve Konuşgaç açılır;
   masaüstüne ve Başlat menüsüne kısayol eklenir.
   Uygulama henüz kod imzalı olmadığı için Windows "Bilinmeyen yayımcı" uyarısı gösterebilir: **Ek bilgi → Yine de çalıştır**.
2. Hesap aç, bu kadar. Uygulama doğrudan Konuşgaç'ın sunucusuna ([konusgac.com](https://konusgac.com)) bağlanır;
   sunucu adresi sormaz. Kendi sunucusu olanlar Ayarlar → Gelişmiş → "Başka sunucuya bağlan" ile ona geçer.

Güncellemeler kendiliğinden gelir: yeni sürüm arka planda iner, uygulamayı kapatınca kurulur.

Masaüstü uygulaması şart değil: [konusgac.com](https://konusgac.com) tarayıcıda da açılır.

### Kendi sunucunu kurmak

Boş bir Ubuntu/Debian sunucuda, alan adının DNS kaydını sunucuya yönlendirdikten sonra tek komut:

```bash
curl -fsSL https://raw.githubusercontent.com/atunca96/konusgac/main/kur.sh | sudo bash -s -- konusgac.ornek.org
```

Docker'ı, Konuşgaç'ı ve HTTPS'i kurar; aynı komut sonra güncellemek için de kullanılır.
Ayrıntılar, Docker'sız kurulum, yedekleme: **[docs/KURULUM.md](docs/KURULUM.md)**.

### Geliştirmek

Gereksinim: Node.js 22.19+ veya 24.11+.

```bash
npm install
npm run build      # web istemcisini derler
npm start          # http://localhost:3001
npm run dev        # geliştirme: Vite 5173 + sunucu 3001, otomatik yenileme
npm run desktop    # Electron penceresi (yerel sunucuyu kendisi başlatır)
npm test           # sunucunun uçtan uca testleri
npm run test:voice # iki gerçek tarayıcıyla ses testi (Chrome gerekir, önce npm run build)
npm run typecheck
npm run dist:desktop  # Windows kurulum dosyası: packages/desktop/release/
scripts/kurulum-derle.sh   # aynısı Docker içinde (Windows imzasız dosyayı engellerse)
scripts/sunucuya-gonder.sh <IP> <alan adı>   # kodu ve kurulum dosyasını doğrudan sunucuya kurar
```

Deneme verisi (sunucu çalışırken): `npm run seed -w @konusgac/server`. Katkı rehberi: [CONTRIBUTING.md](CONTRIBUTING.md).

## Mimari

```
packages/
  shared/   Ortak tipler, izin hesaplama, gateway protokolü, bahsetme yardımcıları
  server/   Fastify REST API + WebSocket gateway + SQLite (node:sqlite) + dosya ekleri
  web/      React + Vite istemcisi
  desktop/  Electron kabuğu ve Windows kurulum dosyası
```

- **REST** (`/api/...`) tüm değişiklikleri yapar; **gateway** (`/gateway`, WebSocket) değişiklikleri ilgili
  kullanıcılara `DISPATCH` olayları olarak iletir. Bağlantı: `HELLO → IDENTIFY → READY`, ardından kalp atışı.
- İzinler sunucuda hesaplanır; kullanıcı göremediği kanalların adını bile almaz. Bir rol veya kanal izni
  değiştiğinde etkilenen her üyeye kendi filtrelenmiş sunucu görünümü yeniden gönderilir.
- Ses ve görüntü sunucu üzerinden akar (mediasoup ile SFU): herkes her akışını (mikrofon,
  kamera, ekran, ekran sesi) bir kez gönderir, sunucu kanaldaki diğerlerine dağıtır. Kamera ve ekran birkaç
  kalitede gönderilir (simulcast); herkes ekranda ne kadar büyük gösteriyorsa o kaliteyi alır, izlemediği yayını
  hiç indirmez. Tüm medya tek bir porttan (40000, UDP ve TCP) geçer; TURN sunucusu gerekmez.
- Dosya ekleri diskte rastgele 128 bitlik anahtarlarla durur; türleri dosyanın ilk baytlarından belirlenir,
  yalnızca resim, video ve ses satır içinde gösterilir, diğer her şey indirme olarak sunulur.
- Kimlikler zaman sıralı 64 bitlik "snowflake" değerleridir.

### Tasarım notları

Masaüstü uygulaması ince bir Electron kabuğu, asıl arayüz web istemcisidir; kabuk ile sayfa arasında tek ve izin
listeli bir köprü vardır. Tüm kod bu proje için yazıldı ve AGPL-3.0 ile açıktır.

## Yol haritası

- Mesaj sabitleme, konular (thread), özel emojiler
- Moderasyon araçları: susturma, yasaklama, denetim kaydı
- Mobil uygulama
- Masaüstü otomatik güncelleme, macOS ve Linux kurulum paketleri

## Lisans

[GNU Affero Genel Kamu Lisansı v3.0](LICENSE) (AGPL-3.0-only).

---

### English

Konuşgaç is a free, open-source, self-hosted chat app (servers, channels, voice, DMs, roles), written in
Turkish for communities in Türkiye. Run your own server with `docker compose up -d` (see
[docs/KURULUM.md](docs/KURULUM.md)), connect with a browser or the Windows desktop app. Licensed under AGPL-3.0.
