# PX POS

Kasir & backoffice untuk layanan **Rent Bike, E-Bike, Laundry, Massage, Snorkeling** — Android (APK) dan web.

- **Web:** GitHub Pages — `https://sumaantara.github.io/PX-POS/`
- **APK Android:** [Releases → PX-POS.apk](../../releases/latest) (dibangun otomatis oleh GitHub Actions setiap ada perubahan)
- **Database & login:** Supabase project `PX POS` (org ONEderland, Singapore, `nmpinkizjivkhxbndtdk`)

## Dua aplikasi, satu kode

| | **Android app (APK) = Kasir** | **Website = Back office** |
|---|---|---|
| Siapa | semua akun aktif (kasir, admin, owner) | **hanya owner & admin** (kasir ditolak) |
| Menu | Sale · History (hari ini & kemarin) · Rentals · Shift · Settings (printer) | Dashboard · Reports · Transactions (void) · Rentals · Shifts · Services & prices · Users · Settings |
| Cetak | Bluetooth printer (ESC/POS, logo raster) / RawBT | dialog print browser |

Semua tampilan & struk berbahasa Inggris. Mode ditentukan otomatis: di dalam APK → kasir, di browser → back office.

### Back office → Settings
- **Business**, **Receipt**: logo (upload, dicetak hitam-putih di struk), teks atas, *thank-you message*, footer, prefix no. struk
- **Tax & service charge**: nama + persen masing-masing (service dihitung dari subtotal setelah diskon; pajak dari subtotal + service; 0 = mati)
- **Payments**, batas diskon kasir
- **Daily sales email**: on/off, jam kirim (WITA), banyak penerima, tombol *Send now*, log pengiriman

### Email penjualan harian
`pg_cron` memanggil edge function `daily-report` tiap jam; function mengirim sekali sehari pada jam yang dipilih
(ringkasan, per kategori/layanan/metode/kasir, daftar transaksi, sepeda yang masih keluar). Butuh:
1. Edge Functions → Secrets: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (sama seperti project HRM)
2. `daily-report` → Settings → **Verify JWT with legacy secret: OFF** (function memeriksa pemanggil sendiri)

### Harga awal (ubah kapan saja di Backoffice → Layanan & Harga)

| Layanan | Harga |
|---|---|
| Bike Rental | Rp 50.000 / day |
| E-Bike Rental | Rp 250.000 / day |
| Massage | Rp 350.000 / session |
| Private Snorkeling 2 hours | Rp 1.100.000 |
| Private Snorkeling 3 hours | Rp 1.300.000 |
| Private Snorkeling 4 hours | Rp 1.500.000 |
| Laundry | Rp 15.000 / kg *(contoh — sesuaikan)* |

## Peran & keamanan (dijaga di database, Row Level Security)

| Role | Bisa |
|---|---|
| **Owner** | semuanya, termasuk membuat admin |
| **Admin** | backoffice, ubah harga, void, kelola kasir |
| **Kasir** | transaksi, cetak, rental, shift sendiri; diskon dibatasi (*Maks. diskon kasir*) |

- Akun pertama yang dibuat = **Owner**. Akun lain yang daftar sendiri menunggu diaktifkan.
- Kasir dibuat admin di **Backoffice → Pengguna** dengan **username + password** (tanpa email).
- Total, harga dan nomor struk dihitung di server (`create_sale`) — kasir tidak bisa mengubah harga.

## Printer struk

Setelan → Printer (disimpan per perangkat):

1. **Bluetooth (APK)** — printer thermal 58/80 mm biasa (ESC/POS). Pair dulu di Pengaturan Bluetooth Android, lalu *Pilih printer*.
2. **Bluetooth BLE (Chrome)** — untuk versi web, printer yang mendukung BLE.
3. **RawBT** — aplikasi Play Store untuk printer Bluetooth dari browser.
4. **Dialog print sistem** — printer apa saja / simpan PDF.

## Struktur

```
www/                     aplikasi (HTML/CSS/JS, tanpa build step)
  js/config.js           URL + anon key Supabase (publik, aman — akses diatur RLS)
  js/app.js              kasir + backoffice
  js/printer.js          layout struk + ESC/POS + cara cetak
supabase/migrations/     schema, RLS, fungsi (create_sale, void_sale, shift, laporan)
supabase/functions/      admin-users (buat akun kasir, reset password)
android-overlay/         plugin Bluetooth printer (Java) untuk APK
tools/prepare-android.py patch project Android (izin Bluetooth, signing, versi)
.github/workflows/       build APK + deploy GitHub Pages
```

## Setup ulang dari nol

1. Supabase → New project → SQL Editor → jalankan `supabase/migrations/0001_init.sql`.
2. Edge Functions → deploy `admin-users` (isi `supabase/functions/admin-users/index.ts`), lalu di Settings function itu
   matikan **Verify JWT with legacy secret** (function sudah mengecek login & role sendiri; project baru memakai kunci JWT ECC).
3. Authentication → URL Configuration → Site URL = `https://sumaantara.github.io/PX-POS/`.
4. Isi `www/js/config.js` dengan Project URL + publishable key → push → APK & web terbangun otomatis.
5. Buka aplikasi → *Daftar akun baru* pakai **email asli** → klik link konfirmasi → akun pertama jadi Owner.
   Akun kasir dibuat Owner/Admin di Backoffice → Pengguna (username + password, tanpa email).

## Tes

- `tools/test-db.sql` — tes database (jalankan di SQL Editor; semua di-rollback, hasil tampil sebagai pesan error `PX-POS-TEST`).
- `python3 tools/ui-smoke/run.py` — tes UI di Chrome headless dengan Supabase tiruan (tablet + HP).

APK ditandatangani dengan keystore di GitHub Secrets (`PX_KEYSTORE_BASE64`, `PX_KEYSTORE_PASSWORD`, `PX_KEY_ALIAS`, `PX_KEY_PASSWORD`). **Simpan cadangan keystore** — tanpa itu update APK harus uninstall dulu.
