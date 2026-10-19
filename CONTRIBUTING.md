# Katkı rehberi

Konuşgaç'a katkı vermek istediğin için teşekkürler! Hata bildirimi, öneri, çeviri, belge ya da kod: hepsi değerli.

## Geliştirme ortamı

```bash
npm install
npm run dev   # Vite 5173 + sunucu 3001
npm run seed -w @konusgac/server   # iki demo hesap ve bir demo sunucusu (sunucu çalışırken)
```

## Bir değişiklik göndermeden önce

- `npm run typecheck` ve `npm test` geçmeli; web arayüzünü değiştirdiysen `npm run build` de.
- Ses kodunu değiştirdiysen `npm run test:voice` çalıştır (Chrome gerekir).
- Yeni bir sunucu davranışı için `packages/server/test/` altına test ekle.
- İzinler her zaman sunucuda denetlenir; istemci yalnızca gösterir. Görünürlüğü etkileyen değişikliklerde `gateway.resyncGuild()` kullanılır.
- Veritabanı şeması değişirse `packages/server/src/db.ts` içindeki `migrate()` ve `user_version` güncellenir;
  eski veritabanlarının taşındığını gösteren bir test ekle.
- Arayüz metinleri Türkçedir. Kod içi adlar ve yorumlar İngilizcedir.

## İlkeler

- **Ücretsiz kalır.** Ücretli seviye, abonelik ya da yalnızca ödeyenlere açık özellik eklenmez.
- **Gizlilik.** Telemetri, izleme ya da üçüncü taraf analitik eklenmez.
- **Özgün kod.** Başka uygulamaların kodu kopyalanmaz; davranışlar gözlemlenip sıfırdan yazılır.

## Lisans

Gönderdiğin katkılar projenin lisansı olan [AGPL-3.0](LICENSE) altında yayımlanır.
