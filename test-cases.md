# Test Cases — Parsing Bahasa Indonesia

Manual validation set for the text parser (`services/llm.ts` → `parseTransaction`).
Run through these before going live to sanity-check the prompt. Expected output is the
normalized JSON per item: `{amount, category, description, payment_method, date_offset}`.

Categories assumed: Makan, Transportasi, Belanja Rumah Tangga, Kesehatan, Hiburan,
Tagihan, Anak & Keluarga, Investasi & Tabungan, Sosial & Hadiah, Lainnya.

## Single transaction

| # | Input | amount | category | payment | date_offset |
|---|-------|-------:|----------|---------|:-----------:|
| 1 | `makan siang 25rb` | 25000 | Makan | cash | 0 |
| 2 | `grab ke rs 18.500` | 18500 | Transportasi | cash | 0 |
| 3 | `token listrik 200k` | 200000 | Tagihan | cash | 0 |
| 4 | `beli buku anak 150rb bbw` | 150000 | Anak & Keluarga | cash | 0 |
| 5 | `gopay 50k bensin` | 50000 | Transportasi | ewallet | 0 |
| 6 | `bayar wifi indihome 350rb` | 350000 | Tagihan | cash | 0 |
| 7 | `kopi kenangan 22rb qris` | 22000 | Makan | qris | 0 |
| 8 | `tf ke tukang sayur 60k` | 60000 | Belanja Rumah Tangga | transfer | 0 |
| 9 | `obat batuk apotek 45rb` | 45000 | Kesehatan | cash | 0 |
| 10 | `nonton bioskop 100k` | 100000 | Hiburan | cash | 0 |
| 11 | `parkir 2` | 2000 | Transportasi | cash | 0 |
| 12 | `pulsa 25rb dana` | 25000 | Tagihan | ewallet | 0 |
| 13 | `zakat 200rb` | 200000 | Sosial & Hadiah | cash | 0 |
| 14 | `nabung reksadana 500k` | 500000 | Investasi & Tabungan | transfer | 0 |
| 15 | `belanja indomaret 87.500` | 87500 | Belanja Rumah Tangga | cash | 0 |
| 16 | `beli martabak 2,5jt` (mahal!) | 2500000 | Makan | cash | 0 |

## Date offsets

| # | Input | amount | date_offset |
|---|-------|-------:|:-----------:|
| 17 | `belanja sayur kemarin 75rb` | 75000 | -1 |
| 18 | `bensin 2 hari lalu 100k` | 100000 | -2 |
| 19 | `bayar galon kemaren 20rb` | 20000 | -1 |

## Multi-transaction (single message → array)

| # | Input | expected |
|---|-------|----------|
| 20 | `makan 25rb, parkir 2rb, kopi 18rb` | [25000/Makan, 2000/Transportasi, 18000/Makan] |
| 21 | `grab 30k dan makan 45k` | [30000/Transportasi, 45000/Makan] |
| 22 | `beli beras 120rb, minyak 35rb, telur 28rb` | [120000, 35000, 28000] semua Belanja Rumah Tangga |

## Payment method keywords

| # | Input | payment |
|---|-------|---------|
| 23 | `bayar ovo 40k` | ewallet |
| 24 | `shopeepay 15rb` | ewallet |
| 25 | `transfer bca 250k` | transfer |
| 26 | `gesek debit 300k` | debit |
| 27 | `bayar kartu kredit 1jt` | cc |

## Pemasukan (type = income; category = sumber, bebas)

| # | Input | amount | type | category |
|---|-------|-------:|------|----------|
| 28 | `gaji 8jt` | 8000000 | income | Gaji |
| 29 | `dapat bonus 2jt kemarin` | 2000000 | income | Bonus |
| 30 | `thr 5jt` | 5000000 | income | Thr |
| 31 | `refund tokopedia 150rb` | 150000 | income | Refund (dsb) |
| 32 | `cashback gopay 20rb` | 20000 | income | Cashback (dsb) |

## Tabungan (type = saving; category = tujuan, bebas)

| # | Input | amount | type | category |
|---|-------|-------:|------|----------|
| 33 | `nabung 500rb` | 500000 | saving | Tabungan |
| 34 | `nabung dana darurat 1jt` | 1000000 | saving | Dana Darurat |
| 35 | `nabung 2jt buat liburan` | 2000000 | saving | Liburan |
| 36 | `sisihkan 300rb buat umroh` | 300000 | saving | Umroh |
| 37 | `investasi reksadana 1jt` | 1000000 | saving | Reksadana (dsb) |

## Non-transaction (must return `[]`)

| # | Input | expected |
|---|-------|----------|
| 38 | `halo bot` | `[]` |
| 39 | `bulan ini habis berapa?` | `[]` |
| 40 | `makasih ya` | `[]` |

---

# Vision Test Images (`test-images/`)

Collect 10+ real samples for manual validation of the vision prompt before going live:

- [ ] Struk Indomaret / Alfamart (grand total, payment cash/qris)
- [ ] Struk restoran dengan pajak + service charge (catat grand total, bukan subtotal)
- [ ] Screenshot notifikasi GoPay (payment → ewallet)
- [ ] Screenshot notifikasi Dana / OVO (ewallet)
- [ ] Screenshot bukti transfer BCA / m-banking (payment → transfer)
- [ ] Screenshot QRIS payment (payment → qris)
- [ ] Screenshot daftar mutasi dengan banyak transaksi keluar (→ array multi)
- [ ] Screenshot mutasi berisi transaksi MASUK (→ diabaikan / "transaksi masuk belum didukung")
- [ ] Struk buram / terpotong (→ confidence "low", memicu konfirmasi bukan tulis langsung)
- [ ] Foto random non-struk (→ `{"not_receipt": true}`)
- [ ] Struk + caption "patungan, catat setengahnya" (→ nominal dibagi 2 sesuai caption)
