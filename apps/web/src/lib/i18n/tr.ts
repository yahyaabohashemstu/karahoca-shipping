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
    save: 'Kaydet',
    add: 'Ekle',
    edit: 'Düzenle',
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
  signal: {
    label: {
      LIVE: 'Canlı',
      DELAYED: 'Gecikmeli',
      STALE: 'Eski',
      LOST: 'Sinyal yok',
      NO_SIGNAL: 'Başlamadı',
      PAUSED: 'Durduruldu',
    },
    description: {
      LIVE: 'Son 90 saniye içinde konum alındı',
      DELAYED: 'Son konum 90 saniye – 10 dakika önce',
      STALE: 'Son konum 10 dakika – 2 saat önce',
      LOST: 'Son konumun üzerinden 2 saatten fazla geçti',
      NO_SIGNAL: 'Sürücü henüz takibi başlatmadı',
      PAUSED: 'Sürücü takibi durdurdu — araç konum göndermiyor',
    },
  },

  status: {
    ASSIGNED: 'Kod bekliyor',
    CLAIMED: 'Cihaz bağlandı',
    ACTIVE: 'Yolda',
    PAUSED: 'Duraklatıldı',
    COMPLETED: 'Teslim edildi',
    CANCELLED: 'İptal edildi',
    EXPIRED: 'Süresi doldu',
  },
  map: {
    toFlat: 'Düz haritaya geç',
    toDimensional: 'Üç boyutlu görünüme geç — araçlar, binalar ve arazi',
    zoomForModels: 'Araç modelleri için yakınlaştırın',
    renderFault: 'Harita bir kareyi çizemedi ve atladı — takip sürüyor. Sorun tekrarlarsa 3B’yi kapatın.',
    fitAll: 'Tüm araçları haritaya sığdır',
    showAll: 'Tümünü göster',
    qualityDown: (ms: string) => `Bu bilgisayar yetişemedi (${ms} ms/kare) — `,
    qualityUp: 'Performans uygun — ',
    quality: {
      flat: 'Düz harita',
      vehicles: '3B araçlar',
      buildings: '3B araçlar ve binalar',
      terrain: '3B araçlar, binalar ve arazi',
    },
  },
  http: {
    noEntries: 'Kayıtlı hata yok.',
    noConnection: 'bağlantı yok',
    unreachable: 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edin.',
    badRequest: 'Gönderilen bilgilerde eksik veya hatalı alan var.',
    unauthorised: 'Oturumunuz sona ermiş. Yeniden giriş yapın.',
    forbidden: 'Bu işlem için yetkiniz yok.',
    notFound: 'Aranan kayıt bulunamadı.',
    conflict: 'Bu kayıt başka bir işlemle çakışıyor.',
    rateLimited: 'Çok fazla deneme yapıldı. Kısa bir süre bekleyin.',
    unavailable:
      'Sunucu şu anda yanıt vermiyor (güncelleme yapılıyor olabilir). Birkaç saniye sonra tekrar deneyin.',
    serverError: (status: string) => `Sunucu hatası (HTTP ${status}).`,
    unexpected: (status: string) => `Beklenmeyen yanıt (HTTP ${status}).`,
    reportHeading: 'KaraHoca — istemci hata kaydı',
    reportGenerated: 'Oluşturma',
    reportBrowser: 'Tarayıcı',
  },
  diagnostics: {
    title: 'Hata kaydı',
    button: (count: string) => `Hata kaydı — ${count} kayıt`,
    recent: (count: string) => `son ${count} başarısız istek`,
    copy: 'Kaydı kopyala',
    copied: 'Hata kaydı kopyalandı',
    copiedBody: 'Destek için gönderebilirsiniz.',
    copyFailed: 'Kopyalanamadı',
    clear: 'Temizle',
  },
  cadence: {
    heading: 'Konum gönderme sıklığı',
    modeLabel: 'Konum gönderme yöntemi',
    modeTime: 'Zamana göre',
    modeDistance: 'Mesafeye göre',
    everyMetres: 'Her kaç metrede bir',
    everyMetresHint: 'Araç bu kadar yol aldığında bir konum kaydedilir.',
    maxRate: 'En sık örnekleme',
    maxRateHint: 'Mesafe şartı sağlansa bile bundan daha sık kayıt yapılmaz.',
    everySeconds: 'Her kaç saniyede bir',
    everySecondsHint: 'Araç hareket hâlindeyken konum gönderme aralığı.',
    idle: 'Araç dururken',
    idleHintDistance: 'Duran araç bu aralıkta bir “buradayım” konumu gönderir.',
    idleHintTime: 'Araç durduğunda uygulama bu seyrek aralığa geçer.',
    estimateDistance:
      'Yaklaşık {0} konum kaydı / 500 km. Duran araç, sinyalsiz sanılmaması için {1} aralıkla kayıt göndermeye devam eder.',
    estimateTime:
      'Yaklaşık {0} konum kaydı / saat. Sık aralık daha detaylı rota, daha fazla pil tüketimi demektir.',
    errInterval: (min: string, max: string) =>
      `Konum aralığı ${min}–${max} saniye arasında olmalı.`,
    errDistance: (min: string, max: string) => `Mesafe ${min}–${max} metre arasında olmalı.`,
    errIdle: (min: string, max: string) => `Bekleme aralığı ${min}–${max} saniye arasında olmalı.`,
    unitSec: 'sn',
    unitMin: 'dk',
    unitHour: 'sa',
    unitMetre: 'm',
  },
  picker: {
    search: 'Yer ara',
    searchPlaceholder: 'Erbil sanayi, Habur, Bab al-Hawa…',
    searchHint: 'Adı yazın ve seçin, ya da doğrudan haritaya tıklayın.',
    searching: 'Aranıyor…',
    selected: 'Seçilen nokta',
    fromMap: 'Haritadan seçildi',
    radius: 'Varış yarıçapı',
    remove: 'Kaldır',
  },

  consignment: {
    customer: 'Sevk edilen firma',
    newCustomer: '+ Yeni firma',
    choose: 'Seçiniz…',
    countryDash: 'Ülke —',
    countryHint:
      'Ülke firma kaydından gelir. Farklıysa firmayı düzenleyin veya yeni firma ekleyin.',
    items: 'Yüklenen ürünler',
    itemsOptional: '— isteğe bağlı',
    itemName: 'Ürün adı — örn. Bulaşık deterjanı 5 L',
    itemQuantity: 'Adet',
    addItem: '+ Ürün ekle',
  },
  share: {
    heading: 'Alıcı takip bağlantısı',
    create: 'Yeni bağlantı',
    none: 'Bu sevkiyat için henüz bağlantı yok.',
    unrecoverable: 'Bu bağlantının adresi geri getirilemiyor. Yeni bir bağlantı oluşturun.',
    viewed: (count: string, when: string) => `${count} kez görüntülendi · son ${when}`,
    notOpened: 'Alıcı henüz açmadı',
    validUntil: (date: string) => `${date} tarihine kadar geçerli`,
    whatsapp: 'WhatsApp',
    copy: 'Kopyala',
    preview: 'Önizle',
    revoke: 'İptal et',
    closed: (count: string) => `${count} kapalı bağlantı (iptal edilmiş veya süresi dolmuş)`,
    created: 'Takip bağlantısı oluşturuldu',
    createdBody: 'Alıcıya gönderebilirsiniz.',
    createFailed: 'Bağlantı oluşturulamadı',
    revoked: 'Bağlantı iptal edildi',
    revokedBody: 'Bu bağlantı artık açılmıyor.',
    revokeFailed: 'İptal edilemedi',
    copied: 'Kopyalandı',
    copyFailed: 'Kopyalanamadı',
    copyFailedBody: 'Adresi elle seçip kopyalayın.',
    /*
     * The WhatsApp text, which is the one string here a customer reads rather
     * than a dispatcher. It follows the dispatcher's language deliberately:
     * WhatsApp opens with it pre-filled and editable, so the person sending it
     * can read what they are about to send — and the consignee page it links to
     * picks its own language from the customer's country regardless.
     */
    whatsappText: (customer: string, order: string, url: string) =>
      `${customer} — ${order} sevkiyatınızı buradan canlı takip edebilirsiniz:
${url}`,
  },
  alerts: {
    centre: 'Uyarı merkezi',
    heading: 'Uyarılar',
    loadFailed: 'Uyarılar alınamadı',
    pending: (count: string) => `Uyarılar — ${count} bekleyen`,
    nonePending: 'Uyarılar — bekleyen yok',
    ackAllTitle: 'Listedeki tüm uyarıları gördüm olarak işaretle',
    ackAll: 'Tümünü gördüm',
    ackAllFailed: 'Uyarılar işaretlenemedi',
    ackFailed: 'Uyarı işaretlenemedi',
    noSocket: 'Canlı bağlantı yok — liste 20 saniyede bir yenileniyor.',
    emptyTitle: 'Açık uyarı yok',
    emptyBody:
      'Bir araç sessizleştiğinde, varışa ulaştığında veya bataryası bittiğinde burada görünür.',
    groupOpen: 'Şu anda açık',
    groupResolved: 'Kendiliğinden düzeldi',
    seen: 'Görüldü',
    seenBy: (name: string) => `Gören: ${name}`,
    seenByUnknown: 'bilinmiyor',
    ack: 'Gördüm olarak işaretle',
    acked: 'Gördüm olarak işaretlendi',
    callDriver: 'Sürücüyü ara',
    callDriverTitle: (who: string) => `Sürücüyü ara — ${who}`,
    severity: { CRITICAL: 'Kritik', WARNING: 'Uyarı', INFO: 'Bilgi' },
    kind: {
      SIGNAL_LOST: 'Sinyal kesildi',
      ARRIVED: 'Varışa ulaştı',
      BATTERY_LOW: 'Batarya düşük',
      MOCK_LOCATION: 'Sahte konum',
      NOT_STARTED: 'Takip başlamadı',
      STOPPED_TOO_LONG: 'Uzun süredir duruyor',
    },
    resolvedAgo: (ago: string) => `${ago} düzeldi`,
    agoJustNow: 'az önce',
    agoMinutes: (n: string) => `${n} dk önce`,
    agoHours: (n: string) => `${n} sa önce`,
    agoDays: (n: string) => `${n} gün önce`,
  },
  customer: {
    editTitle: 'Müşteriyi düzenle',
    newTitle: 'Yeni müşteri',
    editDescription: 'Teslim noktası ve ülke, alıcının takip sayfasını doğrudan etkiler',
    newDescription: 'Sevkiyatın teslim edileceği taraf',
    updated: 'Müşteri güncellendi',
    added: 'Müşteri eklendi',
    updateFailed: 'Güncellenemedi',
    addFailed: 'Müşteri eklenemedi',
    code: 'Kod',
    codePlaceholder: 'MGZ-01',
    codeFixed: 'Kod değiştirilemez',
    name: 'Ünvan',
    namePlaceholder: 'Örnek Market A.Ş.',
    country: 'Ülke',
    city: 'Şehir',
    cityPlaceholder: 'Manisa',
    contact: 'Yetkili',
    phone: 'Telefon',
    arabicNote: 'Bu ülke seçiliyken alıcının takip sayfası {0} açılır.',
    arabicNoteWord: 'Arapça',
    defaultDestination: 'Varsayılan teslim noktası',
    destinationHint:
      'Bu müşterinin siparişleri bu noktayı otomatik devralır. Boş bırakılırsa kalan mesafe hesaplanamaz ve varış otomatik tespit edilemez.',
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
