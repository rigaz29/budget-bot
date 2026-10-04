# Budget Planner Telegram Bot

Bot Telegram **private** untuk mencatat & memonitor keuangan rumah tangga (2 user).
Kirim pesan natural Bahasa Indonesia (`makan siang 25rb`) **atau foto struk / screenshot
mutasi**, bot mem-parsing via LLM dan menyimpan ke **Google Sheets**.

- Friksi minimal: kirim chat → langsung tercatat.
- LLM hanya untuk parsing (deterministik, `temperature 0`), bukan agent.
- Google Sheets = satu-satunya sumber data (mudah diaudit manual).
- Long polling → tidak membuka port apa pun.

---

## Fitur

- **Teks bebas**: `grab ke rs 18.500`, `token listrik 200k kemarin`.
- **Pemasukan & Tabungan**: `gaji 8jt`, `dapat bonus 2jt`, `nabung dana darurat 500rb` —
  bot mengenali jenis transaksi otomatis (pengeluaran / pemasukan / tabungan).
- **Arus kas**: Saldo = Pemasukan − Pengeluaran − Tabungan, dengan target tabungan per tujuan.
- **Multi-transaksi** dalam satu pesan: `makan 25rb, parkir 2rb, kopi 18rb`.
- **Foto**: struk belanja, notifikasi GoPay/OVO/Dana/QRIS, bukti transfer & mutasi bank
  (uang masuk dicatat sebagai pemasukan); struk buram memicu konfirmasi.
- **Caption foto** jadi konteks kategorisasi (mis. "patungan, catat setengahnya").
- **Undo**: tombol `❌ Batalkan` di tiap konfirmasi + `/undo` (transaksi terakhir menurut waktu
  catat, jadi tetap benar walau tab Transactions di-sort di browser).
- **Tahan restart**: pesan yang terkirim saat bot mati/restart tetap diproses begitu bot hidup;
  tanggal mengikuti waktu pesan dikirim, bukan waktu diproses.
- **/recap**, **/budget**, **/tabungan** dengan periode custom (default mulai tanggal 25 / gajian).

---

## Cara tercepat (wizard) ⚡

Setelah punya 3 kredensial (BotF, OpenRouter key, service-account.json + Spreadsheet ID),
tidak perlu mengisi file manual:

```bash
npm install
npm run setup        # wizard interaktif menulis .env untukmu
npm run init-sheet   # buat 4 tab + kategori default
npm run style-sheet  # percantik: tab Dashboard + styling semua tab
npm run build && npm start
```

`npm run setup` akan:
- **memverifikasi BOT_TOKEN** langsung ke Telegram (menampilkan @username bot),
- **mendeteksi chat ID otomatis** — cukup kirim pesan ke bot dari tiap HP, ID tertangkap sendiri,
- membaca `service-account.json` & menampilkan email yang harus di-share ke Sheet,
- menerima **URL spreadsheet** lengkap (ID diekstrak otomatis),
- menawarkan **`npm run init-sheet`** untuk membuat 4 tab + kategori default secara otomatis.

Detail cara mendapatkan tiap kredensial ada di bawah. Kalau mau isi manual, lihat bagian
[Konfigurasi `.env`](#4-konfigurasi-env).

## Alur setup (ringkas)

1. Buat bot di Telegram (BotFather) → dapat `BOT_TOKEN`.
2. Siapkan Google Cloud Service Account + Google Sheet (share ke SA).
3. Daftar OpenRouter → dapat `OPENROUTER_API_KEY`.
4. `npm run setup` (isi `.env`) → `npm run init-sheet` (buat tab) → deploy ke VPS.

---

## 1. Telegram (BotFather)

1. Chat [@BotFather](https://t.me/BotFather) → `/newbot` → ikuti langkah → salin **token**.
2. Cari **chat ID** kamu & pasangan: chat [@userinfobot](https://t.me/userinfobot), salin angka `Id`.
3. (Opsional) `/setprivacy` → **Disable** agar bot melihat semua pesan di grup — untuk chat
   private tidak wajib.

---

## 2. Google Cloud + Sheets

### a. Service Account

1. Buka [Google Cloud Console](https://console.cloud.google.com/) → buat / pilih project.
2. **APIs & Services → Enable APIs** → aktifkan **Google Sheets API**.
3. **IAM & Admin → Service Accounts → Create** → beri nama (mis. `budget-bot`).
4. Buka service account → **Keys → Add key → Create new key → JSON** → unduh.
5. Simpan file itu sebagai `service-account.json` di root project. Catat `client_email`-nya
   (mis. `budget-bot@project.iam.gserviceaccount.com`).

### b. Spreadsheet

1. Buat Google Sheet baru. Salin **Spreadsheet ID** dari URL:
   `https://docs.google.com/spreadsheets/d/`**`<SPREADSHEET_ID>`**`/edit`.
2. Klik **Share** → tambahkan `client_email` service account sebagai **Editor**.
3. Buat **4 sheet (tab)** — **atau lewati langkah ini** dan jalankan `npm run init-sheet`
   yang membuat semua tab + header + kategori default otomatis. Nama tab (kalau manual):

   **`Transactions`** — baris pertama header (opsional tapi disarankan):
   | timestamp | date | user | amount | category | description | payment_method | raw_input | id |

   **`Budgets`**:
   | category | monthly_limit |
   | Makan | 2500000 |
   | Transportasi | 1000000 |

   **`Categories`** — satu kolom (boleh pakai header `category`):
   ```
   Makan
   Transportasi
   Belanja Rumah Tangga
   Kesehatan
   Hiburan
   Tagihan
   Anak & Keluarga
   Investasi & Tabungan
   Sosial & Hadiah
   Lainnya
   ```

   **`Config`** — key/value cadangan (boleh dibiarkan kosong, dipakai fase 2).

> Kategori dibaca dari sheet `Categories` saat startup & di-cache. Tambah kategori →
> `/kategori reload` (tanpa deploy ulang).

---

## 3. OpenRouter

1. Daftar di [openrouter.ai](https://openrouter.ai/) → **Keys** → buat key → `OPENROUTER_API_KEY`.
2. Model default:
   - Teks: `deepseek/deepseek-chat` (murah, bagus untuk parsing).
   - Vision: `google/gemini-2.5-flash` (**wajib** model yang bisa baca gambar — DeepSeek chat tidak bisa).

---

## 4. Konfigurasi `.env`

**Cara mudah:** `npm run setup` (wizard di atas) mengisi ini otomatis + verifikasi.

**Cara manual:**

```bash
cp .env.example .env
nano .env            # isi semua nilai
chmod 600 .env service-account.json
```

| Var | Keterangan |
|-----|-----------|
| `BOT_TOKEN` | Token dari BotFather |
| `ALLOWED_CHAT_IDS` | Chat ID yang diizinkan, dipisah koma |
| `USER_NAMES` | `id:Nama` dipisah koma, mis. `111:Ryan,222:Istri` |
| `OPENROUTER_API_KEY` | Key OpenRouter |
| `OPENROUTER_MODEL` | Model teks (default `deepseek/deepseek-chat`) |
| `OPENROUTER_VISION_MODEL` | Model vision (default `google/gemini-2.5-flash`) |
| `GOOGLE_SERVICE_ACCOUNT_PATH` | Path ke `service-account.json` |
| `SPREADSHEET_ID` | ID spreadsheet |
| `TZ` | `Asia/Jakarta` (wajib eksplisit) |
| `BUDGET_START_DAY` | Tanggal mulai periode budget (default 1, mis. 25) |

Konfigurasi divalidasi saat startup (zod). Kalau ada yang salah, bot menolak start dengan
pesan jelas.

---

## 5. Menjalankan (lokal)

```bash
npm install
npm run build        # tsc -> dist/
npm start            # node dist/index.js

# atau mode dev (auto-reload):
npm run dev

# test unit:
npm test
```

---

## 6. Deploy VPS (Ubuntu 24.04 + systemd)

```bash
# 1. Node 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. User khusus + clone
sudo adduser --system --group budgetbot
sudo -u budgetbot -H bash
cd ~ && git clone <repo> budget-bot && cd budget-bot
npm install && npm run build

# 3. Kredensial
# taruh service-account.json di folder ini, lalu:
npm run setup          # wizard mengisi .env & set chmod 600
npm run init-sheet     # buat tab spreadsheet (kalau belum)
exit

# 4. systemd
sudo cp /home/budgetbot/budget-bot/budget-bot.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now budget-bot
sudo journalctl -u budget-bot -f      # lihat log
```

`budget-bot.service` sudah menyetel `Restart=always` dan `TZ=Asia/Jakarta`.

---

## Tampilan spreadsheet (Dashboard)

`npm run style-sheet` mempercantik spreadsheet (tema cream/hangat) & menambah tab **Dashboard**
bergaya budget planner, semua otomatis dari data bot:

- **Arus Kas (KPI cards)**: Pemasukan · Pengeluaran · Tabungan · **Saldo** untuk **periode berjalan**.
- **Pengeluaran vs Budget** per kategori: budget, terpakai, sisa, %, **progress bar** (SPARKLINE),
  dengan **highlight otomatis** kategori ≥90% (merah) / ≥70% (kuning).
- **Pemasukan**: daftar pemasukan terbaru (live).
- **Tabungan**: progres tiap tujuan (terkumpul vs target dari sheet `Tabungan`), tujuan tercapai
  ≥100% disorot hijau.
- **Lacak Pengeluaran**: daftar transaksi terbaru (live).
- **Grafik** (chart native Sheets, auto-update): donut **komposisi pengeluaran** per kategori
  (Dashboard) + batang **Pemasukan vs Pengeluaran per bulan** (Rekap Bulanan). Ditaruh di area
  kosong bawah tabel; di-refresh idempotent (chart lama dihapus sebelum bikin baru).
- **Semua tab**: header berwarna + freeze, baris zebra, format Rupiah (`Rp 1.800.000`) & persen,
  filter di Transactions, warna tab.
- **Aman & idempotent**: hanya formatting + tab Dashboard/Rekap; data transaksi tidak pernah diubah.
  Bisa dijalankan ulang kapan saja (mis. setelah menambah kategori / tujuan tabungan baru).

**Tab `Rekap Bulanan`** (juga dibuat `style-sheet`): pivot per bulan dari SATU sheet Transactions
— Pemasukan, Pengeluaran, Tabungan, Saldo, dan **Saldo Kumulatif** (running balance) tiap bulan,
auto-update. Semua transaksi tetap di satu sheet; bot **tidak** membuat sheet baru tiap bulan —
periode dipisah lewat filter tanggal, jadi tampilan otomatis pindah ke bulan baru saat gantian bulan.

> Catatan teknis:
> - Formula memakai **referensi kolom penuh** (`Transactions!$E:$E`) supaya tidak geser saat bot
>   menambah/menghapus baris.
> - Perbandingan tanggal pakai **teks ISO** (`$B:$B >= "2026-07-01"`), bukan `DATEVALUE` — karena
>   `DATEVALUE` tidak andal untuk format ISO di locale `in_ID`. Tanggal disimpan `YYYY-MM-DD` yang
>   urut secara teks, jadi aman.
> - Locale diset `in_ID` (angka gaya Indonesia); formula ditulis internal dengan konvensi `en_US`
>   lalu disimpan kanonik, jadi tetap jalan.

## Perintah bot

| Command | Fungsi |
|---------|--------|
| `/start`, `/help` | Bantuan singkat |
| `/recap` | Rekap periode berjalan (arus kas + per kategori vs budget + top 5) |
| `/recap minggu` | Rekap 7 hari terakhir |
| `/riwayat` | 10 transaksi terakhir (kalian berdua) · `/riwayat 20` untuk lebih banyak |
| `/budget` | Semua budget & sisa per kategori |
| `/budget Makan 2000000` | Set/update budget kategori |
| `/tabungan` | Progres tabungan (terkumpul vs target per tujuan) |
| `/tabungan Liburan 5000000` | Set/update target tujuan tabungan |
| `/refresh` | Segarkan tab Dashboard & Rekap Bulanan dari Telegram (= `npm run style-sheet`) |
| `/undo` | Hapus transaksi terakhir milikmu |
| `/kategori` | Daftar kategori aktif |
| `/kategori tambah <nama>` | Tambah kategori baru |
| `/kategori hapus <nama>` | Hapus kategori (kecuali "Lainnya") |
| `/kategori reload` | Muat ulang kategori dari sheet |

**Jenis transaksi (deteksi otomatis dari teks):**

| Ketik | Jenis |
|-------|-------|
| `makan siang 25rb` | 💸 Pengeluaran |
| `gaji 8jt` · `dapat bonus 2jt` | 💰 Pemasukan |
| `nabung dana darurat 500rb` · `nabung 1jt buat liburan` | 🏦 Tabungan |

---

## Keamanan

- Whitelist chat ID di middleware paling awal — user lain ditolak.
- `.env` & `service-account.json` `chmod 600`, masuk `.gitignore` (**jangan commit**).
- Long polling → tidak ada port terbuka.
- API key tidak pernah di-log.

---

## Arsitektur singkat

```
src/
  index.ts            # wiring: config -> Sheets init -> load kategori -> handlers -> polling
  config.ts           # load & validasi env (zod)
  middleware/auth.ts  # whitelist chat ID
  handlers/           # transaction (teks), photo (vision), commands, callbacks, persist, pending
  services/           # llm (OpenRouter), sheets (Google Sheets), budget (recap), categoryCache
  utils/              # currency, period, logger
```

## Testing

- Unit (vitest): `currency` (parsing rupiah), `period` (periode budget + edge case Februari),
  `parse` (validasi & normalisasi output LLM + tanggal hari ini di prompt), `budget` (sisa budget,
  tabungan, urutan riwayat), `periodCache` (rollup periode). Jalankan `npm test`.
- `test-cases.md`: 30 contoh input teks untuk validasi manual prompt.
- `test-images/`: kumpulkan sampel struk/mutasi untuk validasi prompt vision (isi folder di-`.gitignore`).

## Roadmap (Fase 2)

Recap terjadwal (cron), alert mendekati limit, income tracking, deteksi anomali, query natural
language. Kode modular — cukup menambah `services/scheduler.ts`.
