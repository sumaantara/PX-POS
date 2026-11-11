# PX POS

Kasir & backoffice untuk layanan **Rent Bike, E-Bike, Laundry, Massage, Snorkeling** — Android (APK) dan web.

- **Web:** GitHub Pages — `https://sumaantara.github.io/PX-POS/`
- **APK Android:** [Releases → PX-POS.apk](../../releases/latest) (dibangun otomatis oleh GitHub Actions setiap ada perubahan)
- **Database & login:** Supabase project `PX POS` (org ONEderland, Singapore, `nmpinkizjivkhxbndtdk`)

## Fitur

| Menu | Isi |
|---|---|
| 🧾 Kasir | Pilih layanan per kategori, qty (hari / jam / kg / sesi / trip), no. sepeda / terapis / guide per item, data tamu, diskon (Rp/%), Cash / QRIS / Transfer / Card, hitung kembalian, cetak struk, kirim struk via WhatsApp |
| 📋 Transaksi | Riwayat per tanggal, cari no. struk / tamu / no. sepeda, cetak ulang, void (admin, wajib alasan) |
| 🚲 Rental | Sepeda & e-bike yang sedang keluar, jatuh tempo kembali, tanda terlambat, tombol "Kembali" |
| ⏱️ Shift | Buka shift (modal awal), tutup shift (hitung kas, selisih), cetak rekap shift |
| 📊 Backoffice | Dashboard (hari ini, bulan ini, grafik 14 hari), Laporan (rentang tanggal, per kategori/layanan/metode/kasir/hari, export CSV, cetak ringkasan), Layanan & Harga, Pengguna, Pengaturan Toko |
| ⚙️ Setelan | Printer per perangkat, ganti password, keluar |

### Harga awal (ubah kapan saja di Backoffice → Layanan & Harga)

| Layanan | Harga |
|---|---|
| Rent Bike | Rp 50.000 / hari |
| E-Bike | Rp 250.000 / hari |
| Massage | Rp 350.000 / sesi |
| Snorkeling Private 2 jam | Rp 1.100.000 |
| Snorkeling Private 3 jam | Rp 1.300.000 |
| Snorkeling Private 4 jam | Rp 1.500.000 |
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
2. Edge Functions → deploy `admin-users` (isi `supabase/functions/admin-users/index.ts`).
3. Authentication → Sign In / Providers → Email: matikan **Confirm email**.
4. Isi `www/js/config.js` dengan Project URL + anon key → push → APK & web terbangun otomatis.
5. Buka aplikasi → *Daftar akun baru* → akun pertama jadi Owner.

APK ditandatangani dengan keystore di GitHub Secrets (`PX_KEYSTORE_BASE64`, `PX_KEYSTORE_PASSWORD`, `PX_KEY_ALIAS`, `PX_KEY_PASSWORD`). **Simpan cadangan keystore** — tanpa itu update APK harus uninstall dulu.
