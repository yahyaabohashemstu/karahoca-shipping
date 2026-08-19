/* =============================================================================
   Turkish — the source of truth
   =============================================================================
   This file defines the shape as well as the text. `Dictionary` is `typeof tr`,
   so ar.ts and ku.ts are checked against it: a key added here and forgotten
   there is a compile error, not a string that silently renders in Turkish on an
   Arabic screen.

   That is the whole completeness story, and it is worth saying why it is enough
   here when the Android app needed a test for the same thing. Android resolves
   a missing translation by falling back to the default at *runtime*, silently.
   TypeScript refuses to build. There is nothing left to assert.

   Conventions:

     Namespaces mirror the file that uses them — `orders` for app/orders,
     `shell` for components/AppShell. A string used by two screens goes in
     `common`, and only then.

     Anything with a number in it is a function taking the already-formatted
     string, never the number: `pending: (n: string) => ...`. Formatting belongs
     to the reader's locale (see format.ts) and a template that takes a number
     invites `${n}` to be interpolated raw.

     Identifiers are never interpolated into the middle of a sentence. Plates,
     order references and session codes are not translated, and a sentence built
     around one reads badly in a language whose word order differs from Turkish.
   ========================================================================== */

export const tr = {
  nav: {
    map: 'Canlı harita',
    sessions: 'Oturumlar',
    orders: 'Siparişler',
    customers: 'Müşteriler',
    carriers: 'Nakliyeciler',
    performance: 'Performans',
  },

  shell: {
    brandSub: 'Sevkiyat Takip',
    brandAria: 'KaraHoca Sevkiyat Takip Merkezi',
    driverApp: 'Sürücü uygulaması',
    driverAppTitle: 'Sürücü uygulamasının kurulum sayfası — track.karahoca.com/app',
    signOut: 'Oturumu kapat',
    language: 'Dil',
    themeSystem: (resolved: string) => `Sistem teması (${resolved}) — değiştirmek için tıklayın`,
    themeDark: 'Koyu tema — açığa geç',
    themeLight: 'Açık tema — koyuya geç',
    themeResolvedDark: 'koyu',
    themeResolvedLight: 'açık',
  },
  login: {
    heading: 'Sevkiyat Takip Merkezi',
    tagline: 'Üçüncü taraf nakliye araçlarının canlı takibi',
    email: 'E-posta',
    password: 'Parola',
    submit: 'Giriş yap',
    submitting: 'Giriş yapılıyor…',
    failedTitle: 'Giriş yapılamadı',
    failedBody: 'Giriş başarısız. E-posta ve parolanızı kontrol edin.',
  },
  titles: {
    appDefault: 'KaraHoca — Sevkiyat Takip Merkezi',
    appDescription: 'Üçüncü taraf nakliye araçları için canlı takip ve rota geçmişi',
    login: 'Giriş',
    orderNew: 'Yeni sipariş',
    sessionNew: 'Yeni takip oturumu',
    sessionDetail: 'Oturum detayı',
  },
  common: {
    loading: 'Yükleniyor…',
    loadFailed: 'Veri alınamadı',
    retry: 'Yeniden dene',
    refresh: 'Yenile',
    close: 'Kapat',
    confirm: 'Onayla',
    cancel: 'Vazgeç',
    search: 'Ara…',
    clearSearch: 'Aramayı temizle',
    previous: 'Önceki',
    next: 'Sonraki',
    live: 'Canlı',
    offline: 'Bağlantı yok',
    staleData: 'Bağlantı kesildi — gösterilen bilgiler eski olabilir.',
  },
  errors: {
    routeTitle: 'Bu ekran yüklenemedi',
    routeBody:
      'Beklenmeyen bir hata oluştu. Takip verileri sunucuda korunuyor — bu yalnızca bu tarayıcı sekmesini etkiler.',
    backToMap: 'Canlı haritaya dön',
    appTitle: 'Uygulama başlatılamadı',
    appBody:
      'Takip verileri sunucuda güvende. Sayfayı yenilemeyi deneyin; sorun sürerse sistem yöneticisine bildirin.',
    code: 'Hata kodu',
    sessionExpired: 'Oturum süresi doldu.',
  },
};

/**
 * The shape every other language must fill.
 *
 * Derived from the Turkish rather than declared separately: one definition
 * cannot drift from the text it describes, and adding a string means editing
 * one file rather than two.
 *
 * Note the absence of `as const` above, which is load-bearing. With it every
 * value narrows to its own literal type and `ar.ts` would be required to
 * contain the Turkish text verbatim — the type would enforce the exact opposite
 * of what it is for.
 */
export type Dictionary = typeof tr;
