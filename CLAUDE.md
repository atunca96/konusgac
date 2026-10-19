# Konuşgaç — proje notları

Gerçek zamanlı sohbet uygulaması: sunucular, kanallar, sesli ve görüntülü sohbet. Arayüz metinleri Türkçe; kullanıcıyla Türkçe konuşulur.
GitHub'da açık kaynak olarak yayımlanacak; Türkiye'deki topluluklar kendi sunucularında kullansın diye.

## Ürün kararları

- **Tamamen ücretsiz.** Abonelik, ücretli seviye veya premium özellik eklenmeyecek.
- **Kendi sunucunda çalışır.** Herkes kendi Konuşgaç'ını kurar; masaüstü uygulaması bağlanacağı sunucunun adresini sorar.
- **Lisans AGPL-3.0-only.** Telemetri ve üçüncü taraf analitik eklenmez.
- Tüm kod bu proje için yazılır. Başka bir ürünün kodu, görseli, sesi ya da metni alınmaz; kod yorumlarında ve
  belgelerde başka ürünlerin adı geçmez, Konuşgaç kendi davranışıyla anlatılır.

## Yapı

npm workspaces monoreposu (Node 22.19+ / 24.11+):

- `packages/shared` — tipler, izin hesaplama (`permissions.ts`), gateway protokolü (`protocol.ts`), bahsetmeler ve arama metni (`mentions.ts`)
- `packages/server` — Fastify 5 REST (`src/routes/*`), WebSocket gateway (`src/gateway.ts`), `node:sqlite` veri katmanı
  (`src/store.ts`, `src/db.ts`), izin otoritesi (`src/access.ts`), hız sınırları (`src/ratelimit.ts`),
  dosya ekleri (`src/files.ts`), ortam ayarları (`src/config.ts`)
- `packages/web` — React 19 + Vite; durum `src/state.ts` (gateway olay reducer'ı), bağlantı `src/connection.ts`, ses `src/voice.ts`
- `packages/desktop` — Electron kabuğu ve Windows kurulum dosyası (electron-builder). Depodan çalışınca yerel sunucuyu
  kendisi başlatır; kurulu sürüm `connect.html` ile sunucu adresini sorar. `preload.cjs` tek ve izin listeli köprü.
- `Dockerfile`, `docker-compose.yml` (Caddy ile otomatik HTTPS), `docs/KURULUM.md` (sunucu kurma rehberi)

## Komutlar

```bash
npm install
npm run build                     # web arayüzünü derler (masaüstü ve npm start bunu sunar)
npm start                         # http://localhost:3001
npm run dev                       # geliştirme: Vite 5173 + sunucu 3001
npm run desktop                   # Electron penceresi (sunucuyu kendisi başlatır)
npm test                          # sunucu uçtan uca testleri
npm run test:voice                # iki gerçek Chrome + sahte mikrofonla ses testi (önce npm run build)
npm run typecheck
npm run dist:desktop              # Windows kurulum dosyası → packages/desktop/release/
npm run seed -w @konusgac/server  # demo hesapları + demo sunucusu (sunucu çalışırken)
```

## Kurallar

- Değişiklikten sonra `npm run typecheck` ve `npm test` geçmeli; web değiştiyse `npm run build`; ses değiştiyse `npm run test:voice`.
- İzinler her zaman sunucuda kontrol edilir; görünürlüğü etkileyen değişikliklerde `gateway.resyncGuild()` kullanılır.
- Veritabanı şeması değişirse `src/db.ts` içindeki `migrate()` ve `user_version` güncellenir; taşıma testi eklenir.
- Kimliği doğrulanmış her değiştiren istek bir hız sınırı kovasından harcar (varsayılan `write`); yeni rotada
  gerekirse `config: { limit: ... }` ile uygun kova seçilir.
- Yüklenen dosyanın türü baytlarından belirlenir; yalnızca resim/video/ses satır içinde sunulur.

## Durum (v0.9)

Çalışan: hesaplar (şifre değiştirme, hesap silme), sunucular/kategoriler/kanallar, davetler, sahiplik devri, canlı mesajlaşma,
yanıtlar, tepkiler, @bahsetmeler ve @everyone, dosya ekleri, sunucuda saklanan okunmamış/bahsetme sayaçları, arama,
yazıyor göstergesi, çevrimiçi durumu, roller ve kanal izinleri, arkadaşlar ve DM, bildirimler, sesli kanallar
(SFU: sunucuda mediasoup, istemcide mediasoup-client; `server/src/sfu.ts`, `web/src/rtc.ts`), hız sınırları ve güvenlik başlıkları, Electron masaüstü uygulaması ve kurulum dosyası, Docker.
Ses ve görüntü (v0.6): her şey sunucudaki SFU'dan geçer. Her sesli kanal bir mediasoup router'ı; tüm medya tek
portta (`KONUSGAC_RTC_PORT`, 40000, UDP+TCP), istemcilerin ulaştığı adres `KONUSGAC_RTC_ADDRESS`. İstemci
gateway üzerinden numaralı istekler gönderir (`Op.Rtc` → `RTC_RESPONSE`, olaylar `RTC_EVENT`). Kaynaklar: mic,
camera, screen, screenAudio; konuşma (`Speak`) ve yayın (`Stream`) izinleri sunucuda zorlanır. Kamera ve ekran
simulcast; yayın ancak "Yayını izle" ile indirilir. Neyin açık olduğunu VoiceState.selfVideo/selfStream söyler.
Masaüstünde ekran seçici `konusgac:screen-sources` + `setDisplayMediaRequestHandler`.
`npm run test:voice` iki gerçek Chrome ile ses, kamera ve yayını SFU üzerinden dener.
Kurulum: masaüstü uygulaması doğrudan konusgac.com'a bağlanır (`desktop/package.json` → `konusgac.defaultServer`);
sunucu `kur.sh` ile tek komutla kurulur. Kurulum dosyası sunucunun `<veri>/indir` klasöründen
`/indir` adresinde sunulur, güncellemeler de oradan (electron-updater, generic). `scripts/kurulum-derle.sh` kurulum dosyasını
Docker+wine ile derler (bu makinede Windows uygulama denetimi imzasız `.exe`'leri engelliyor);
`scripts/sunucuya-gonder.sh` GitHub olmadan kodu ve kurulum dosyasını sunucuya kurar.
E-posta ve Google (v0.7): `server/src/mail.ts` (Resend), `google.ts` (OAuth kod akışı), `routes/account.ts`.
E-posta bağlantıları ve Google dönüş kodu tek kullanımlık (`one_time_tokens`, hash'li); site `?dogrula=`, `?sifirla=`,
`?giris=` ile açılır (`web/src/links.ts`). Masaüstünde Google sistem tarayıcısında açılır, `konusgac://giris?kod=` ile döner.
Anahtarlar sunucuda `.env`'de; `scripts/sunucu-ayari.ps1` ile girilir (değer ekranda/komut satırında görünmez).
Sağ tık menüleri (v0.8): tek sistem `web/src/menu.tsx` (openMenu, MenuHost), menülerin içeriği `menus.tsx`
(messageMenu, userMenu, channelMenu, guildMenu, dmMenu). Her yerden açılan pencereler `ui.tsx` (openDialog).
Masaüstünde sayfanın işlemediği sağ tıklar (metin kutusu) `nativeMenu.tsx` ile aynı görünümde; tepsi menüsü
`desktop/tray-menu.html`. Masaüstü açılışta hemen `splash.html` gösterir, sunucuyu arkada yükler.
Moderasyon (v0.9): `server/src/routes/moderation.ts`. Şikâyetler mesajın kopyasını saklar; platform yöneticileri
`KONUSGAC_YONETICILER` (kullanıcı adları) ile belirlenir ve Ayarlar → Platform yönetimi'ni görür. Sunucu yasakları
`Perm.BanMembers`. Kullanım Koşulları ve KVKK metni `web/public/kosullar.html`, `gizlilik.html` (sunucu doldurur).
Ayarlar (v0.4): ayar bölümleri `web/src/components/settings/` içinde; yerel tercihler `web/src/settings.ts`
(localStorage, seçici her zaman sabit değer döndürmeli), gizlilik ve oturumlar sunucuda. Renkler hep tema değişkeniyle
(`styles.css` :root, temalar `settings.css`); sabit renk yazılmaz, yoksa açık temada okunmaz.

Eksik / sırada: gerçek mikrofonla insan kulağıyla ses denemesi (otomatik test sahte mikrofonla geçiyor); büyük sesli odalar için SFU; moderasyon (yasaklama, susturma, denetim kaydı); kod imzalı kurulum ve otomatik güncelleme.
