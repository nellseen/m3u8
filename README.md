# Telegram HLS/M3U8 Downloader Userbot (Backend-Only)

Telegram Userbot downloader berperforma tinggi berbasis **GramJS** yang bertindak sebagai akun pengguna Telegram nyata (bukan Bot API biasa). Userbot ini dirancang untuk mendeteksi URL video/halaman web, mengekstraksi sumber HLS (`.m3u8`), mengunduh menggunakan sistem multi-layer fallback 5 lapis, memproses container dan metadata video dengan FFmpeg, lalu mengirimkan video kembali ke chat asal dengan dukungan streaming player Telegram.

Dirancang khusus untuk berjalan di lingkungan **Termux (Android)** dan **Ubuntu via PRoot**, serta Linux server standar.

---

## 🏗️ 1. Arsitektur Sistem

```
[ Telegram Message ]
        │
        ▼
[ GramJS Userbot Handler ] ── (Private / Group / Saved Messages)
        │
        ▼
[ Concurrency Queue ] ── (Job ID, Timeout, Isolasi Temp Dir)
        │
        ▼
[ Fallback Orchestrator (5 Lapis) ]
 ├── ENGINE 1: Direct / HLS Detection (HTTP Streams & Cheerio parser)
 ├── ENGINE 2: Playwright + Chromium Sniffer (Network request interceptor)
 ├── ENGINE 3: Streamlink CLI (HLS/VOD & Livestream capture)
 ├── ENGINE 4: yt-dlp CLI (Multi-fragment HLS extractor)
 └── ENGINE 5: FFmpeg Direct Stream (Segment assembly & remuxer)
        │
        ▼
[ FFmpeg Processing Engine ]
 ├── Remux MP4: -c copy -bsf:a aac_adtstoasc -movflags +faststart
 ├── Probe: Video/Audio Codecs, Duration, Width, Height
 └── Snapshot: JPEG Thumbnail Generator (320px)
        │
        ▼
[ Telegram Upload ] ── (SupportsStreaming=true, Thumbnail, Edit Progress)
```

---

## 📁 2. Struktur Direktori Final

```
.
├── .env.example              # Template konfigurasi environment
├── .gitignore                # Filter ignore file sensitif & cache
├── .npmrc                    # Pengaturan pnpm
├── metadata.json             # Metadata applet backend
├── package.json              # Script npm: setup, start, dev, check, doctor, login, test
├── tsconfig.json             # Konfigurasi TypeScript modern
├── README.md                 # Dokumentasi lengkap
├── scripts/
│   ├── setup.sh              # Master setup otomatis (Termux/Ubuntu PRoot idempotent)
│   ├── doctor.ts             # CLI Diagnostik sistem (Node, FFmpeg, Streamlink, yt-dlp, Playwright)
│   ├── login.ts              # CLI interaktif login akun Telegram (GramJS StringSession)
│   └── test-pipeline.ts      # Automated self-audit & pipeline integration test
└── src/
    ├── index.ts              # Entry point utama userbot daemon
    ├── server.ts             # HTTP server Express (Health, Status, Overview)
    ├── config.ts             # Konfigurasi aman & sanitasi rahasia
    ├── logger.ts             # Logger terstruktur dengan proteksi redaksi credential
    ├── types.ts              # Definisi interface & type TypeScript
    ├── bot/
    │   ├── client.ts         # Inisialisasi GramJS TelegramClient & auth checker
    │   ├── handler.ts        # Event listener pesan, perintah, & pengiriman video
    │   └── progress.ts       # Message editor dengan proteksi anti-flood limit Telegram
    ├── engines/
    │   ├── base.ts           # Abstract base class untuk download engine
    │   ├── direct-engine.ts  # Engine 1: Direct stream & Cheerio HTML parser
    │   ├── playwright-engine.ts # Engine 2: Headless Chromium sniffer
    │   ├── streamlink-engine.ts # Engine 3: Streamlink runner
    │   ├── ytdlp-engine.ts   # Engine 4: yt-dlp fragment downloader
    │   ├── ffmpeg-engine.ts  # Engine 5: FFmpeg direct HLS remuxer
    │   └── orchestrator.ts   # Fallback pipeline orchestrator
    ├── queue/
    │   └── download-queue.ts # Antrian konkurensi, isolasi temp dir, & timeout watcher
    └── utils/
        ├── cleaner.ts        # Pembersih proses & folder temporary per job
        ├── ffmpeg.ts         # Media probing, thumbnail maker, & MP4 remuxer
        ├── system.ts         # Deteksi path binary & lingkungan Termux/PRoot
        └── url-extractor.ts  # Deteksi & parser regex URL dari pesan
```

---

## 🚀 3. Panduan Instalasi dari Nol di Termux + Ubuntu PRoot

### Langkah A: Di Lingkungan Termux (Android)

1. Buka Termux dan perbarui package dasar:
   ```bash
   pkg update -y && pkg upgrade -y
   pkg install -y git nodejs-lts pnpm ffmpeg python proot-distro
   ```

2. Pasang Ubuntu di Termux via proot-distro (direkomendasikan untuk stabilitas Playwright & yt-dlp):
   ```bash
   proot-distro install ubuntu
   proot-distro login ubuntu
   ```

### Langkah B: Di Lingkungan Ubuntu PRoot

1. Jalankan script setup otomatis:
   ```bash
   bash scripts/setup.sh
   ```
   *Script setup ini sepenuhnya **idempotent** (aman dijalankan berulang kali). Script akan mendeteksi dependency yang telah ada, memasang FFmpeg, yt-dlp, Streamlink, Playwright Chromium, dependensi Node, serta membuat file `.env` dengan seluruh pengaturan default otomatis.*

2. **Konfigurasi Akun & Login (Satu Perintah Tanpa Edit File Manual)**:
   Anda **TIDAK PERLU** mengedit file konfigurasi atau mengisi variabel environment satu per satu! Seluruh port, direktori kerja, batas unduhan, dan path binary sudah diatur otomatis oleh sistem.

   Satu-satunya yang dibutuhkan adalah `TELEGRAM_API_ID` dan `TELEGRAM_API_HASH` (dari https://my.telegram.org). Cukup jalankan:
   ```bash
   pnpm run login
   ```
   *CLI interaktif akan langsung menanyakan API ID, API Hash, nomor HP, dan kode Telegram Anda, lalu menyimpannya secara otomatis ke `.env` dan `session.txt`!*

---

## 🔑 4. Cara Menjalankan

### 1. Jalankan Diagnostik Sistem (Doctor)
Periksa apakah seluruh dependency dan binary sistem siap:
```bash
pnpm run doctor
```

### 2. Login ke Akun Telegram (Pertama Kali)
Jalankan helper CLI interaktif untuk menghasilkan session Telegram secara aman:
```bash
pnpm run login
```
*Masukkan nomor HP, kode verifikasi dari aplikasi Telegram, dan password 2FA (jika aktif). Session string akan otomatis tersimpan di `session.txt` dan didaftarkan ke bot.*

### 3. Jalankan Userbot
```bash
pnpm start
```
Atau dalam mode development:
```bash
pnpm run dev
```

### 4. Perintah di Telegram
Kirim pesan ke **Saved Messages** (chat akun sendiri), Private Chat, atau Group yang diizinkan:
- `.dl <url>` : Unduh video dengan pipeline multi-layer fallback.
- `.status` : Cek status antrian aktif dan riwayat unduhan.
- `.ping` : Uji latensi koneksi userbot ke server Telegram.
- `.help` : Tampilkan daftar perintah dan panduan format.
- *Atau cukup kirimkan URL link video secara langsung ke Saved Messages untuk otomatis diproses.*

---

## 🧪 5. Hasil Audit & Validasi yang Dilakukan

18/18 Pengujian Integrasi Selesai (**PASS**):
1. **URL Extraction**: Berhasil mengekstrak dan membedakan URL HTTP, HTTPS, M3U8, MP4, dan parameter query.
2. **Orchestrator Registration**: 5 engine fallback terdaftar dan terdeteksi status ketersediaannya.
3. **Directory Isolation**: Setiap job memiliki direktori `./temp/job_<id>` terisolasi tanpa risiko tumpang tindih nama file.
4. **Cleanup Guarantee**: Direktori temporary dan subprocess otomatis dibersihkan saat job selesai/gagal.
5. **Media Probing**: FFmpeg/ffprobe berhasil membaca durasi, resolusi, serta codec audio/video.
6. **Faststart Remuxing**: Video dikemas ulang dengan `-movflags +faststart` agar dapat langsung diputar di Telegram tanpa menunggu selesai unduh penuh.
7. **Thumbnail Extraction**: Pembuatan thumbnail gambar JPEG (320px) berfungsi dengan offset seek yang presisi.
8. **Sequential Fallback**: Saat URL 404 / gagal diuji, sistem mencoba berturut-turut Engine 1 ➔ Engine 2 ➔ Engine 3 ➔ Engine 4 ➔ Engine 5 secara elegan tanpa crash.
9. **Real HLS Pipeline**: Berhasil merangkai segmen HLS TS menjadi MP4 utuh dan valid.
10. **Progress Editing**: Menggunakan satu pesan progress yang di-edit secara berkala dengan debouncing (anti-flood limit).

Jalankan test suite kapan saja dengan:
```bash
pnpm test
```

---

## ✅ 6. Checklist Fitur yang Diimplementasikan

- [x] Full-Stack Backend-Only (tanpa mock UI / dummy frontend).
- [x] Autentikasi GramJS berbasis akun USER Telegram (bukan Bot API).
- [x] Auto Setup Script (`scripts/setup.sh`) multi-OS & idempotent.
- [x] Sistem Multi-Layer Fallback Downloader:
  - [x] Engine 1: Direct URL / HTTP & Cheerio HTML parser.
  - [x] Engine 2: Playwright + Chromium headless network interceptor.
  - [x] Engine 3: Streamlink runner untuk HLS & livestream.
  - [x] Engine 4: yt-dlp multi-fragment engine.
  - [x] Engine 5: FFmpeg HLS direct stream assembler.
- [x] Manajemen Antrian Konkurensi (`MAX_CONCURRENT_JOBS`, isolasi per job, timeout watcher).
- [x] Pemrosesan FFmpeg (Remux MP4, Thumbnail JPG, Probing dimensi & durasi).
- [x] Progress Tracker satu pesan (edit-message debounced) dengan indikator visual.
- [x] Pengiriman media Telegram dengan streaming attribute (`Api.DocumentAttributeVideo`).
- [x] Sanitasi kredensial (API ID, Hash, Session tidak pernah bocor ke log).
- [x] CLI Diagnostik `pnpm run doctor` & CLI Login interaktif `pnpm run login`.
- [x] Server Express di port 3000 untuk endpoint health check dan status monitoring.

---

## 🔧 7. Panduan Troubleshooting

| Gejala Masalah | Penyebab Umum | Solusi |
|---|---|---|
| `TELEGRAM_API_ID is not set` | File `.env` belum diisi kredensial. | Buka https://my.telegram.org, buat App baru, salin API ID & Hash ke file `.env`. |
| `Userbot is NOT authenticated yet` | Session string belum dibuat. | Jalankan `pnpm run login` di terminal untuk autentikasi pertama kali. |
| `Chromium launch failed` di PRoot | Flag sandbox Linux menolak lingkungan proot. | Pastikan argumen `--no-sandbox` dan `--disable-dev-shm-usage` aktif (sudah dikonfigurasi bawaan pada PlaywrightEngine). |
| `FLOOD_WAIT` dari Telegram | Terlalu banyak edit pesan dalam waktu singkat. | ProgressTracker sudah dilengkapi debouncing 1.5 detik. Jika masih terjadi pada akun baru, kurangi konkurensi pada `.env`. |
| `Streamlink / yt-dlp: command not found` | PATH belum mengenali instalasi pip. | Jalankan `bash scripts/setup.sh` atau pastikan `/usr/local/bin` ada di dalam `$PATH`. |
