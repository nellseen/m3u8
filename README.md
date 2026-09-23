# Telegram HLS/M3U8 Downloader Userbot

Telegram Userbot downloader berperforma tinggi berbasis **GramJS** yang bertindak sebagai akun pengguna Telegram nyata (bukan Bot API biasa). Userbot ini dirancang untuk mendeteksi URL video/halaman web, mengekstraksi sumber HLS (`.m3u8`), mengunduh menggunakan sistem multi-layer fallback 6 lapis, memproses container dan metadata video dengan FFmpeg (resolusi maksimal 720p tanpa upscale untuk efisiensi CPU & RAM), lalu mengirimkan video kembali ke chat asal dengan dukungan native streaming player Telegram.

Dirancang khusus dan dioptimalkan untuk berjalan di lingkungan **Termux (Android)** dan **Ubuntu via PRoot ARM64**, serta Linux server standar (x86_64).

---

## 🏗️ 1. Arsitektur Sistem & Multi-Layer Fallback

```
[ Telegram Message / Webhook ]
        │
        ▼
[ GramJS Userbot Handler ] ── (Private / Group / Saved Messages)
        │
        ▼
[ Concurrency Queue ] ── (Job ID, Timeout, Isolasi Temp Dir)
        │
        ▼
[ Fallback Orchestrator (6 Lapis Kaskade) ]
 ├── ENGINE 1: Direct / HLS Detection (HTTP Streams & Cheerio parser)
 ├── ENGINE 2: Playwright + Chromium Sniffer (Generic Fallback: Sniffs .m3u8 & auto-downloads)
 ├── ENGINE 3: Streamlink CLI (HLS/VOD & Livestream capture, prioritas <= 720p)
 ├── ENGINE 4: yt-dlp CLI (Multi-fragment extractor, prioritas <= 720p)
 ├── ENGINE 5: FFmpeg Direct Stream (Segment assembly & remuxer)
 └── ENGINE 6: Secondary Discovered Media Retry
        │
        ▼
[ FFmpeg Processing Engine ]
 ├── Remux MP4: -c copy -bsf:a aac_adtstoasc -movflags +faststart
 ├── Normalisasi Skala: Maksimal 720p (menolak upscale)
 ├── Probe: Video/Audio Codecs, Duration, Width, Height
 └── Snapshot: JPEG Thumbnail Generator (320px)
        │
        ▼
[ Telegram Upload ] ── (SupportsStreaming=true, Thumbnail, Edit Progress Debounced)
```

---

## 📁 2. Struktur Direktori Final

```
.
├── up.sh                     # Quick-start script satu perintah (PNPM approval + setup + env check)
├── .env                      # Konfigurasi aktif runtime (CHROMIUM_PATH=/usr/bin/chromium)
├── .env.example              # Template konfigurasi environment default
├── .gitignore                # Filter ignore file sensitif & cache
├── .npmrc                    # Pengaturan pnpm (ignore-scripts=false)
├── metadata.json             # Metadata applet
├── package.json              # Scripts: setup, up, start, dev, check, doctor, login, test
├── tsconfig.json             # Konfigurasi TypeScript modern
├── README.md                 # Dokumentasi lengkap
├── index.html                # Premium UI Dashboard Promosi (telemetri & stream simulator)
├── scripts/
│   ├── setup.sh              # Master setup installer otomatis (Debian Chromium bypass + PNPM fix)
│   ├── doctor.ts             # CLI Diagnostik sistem (Node, FFmpeg, Streamlink, yt-dlp, Playwright)
│   ├── login.ts              # CLI interaktif login akun Telegram (GramJS StringSession)
│   └── test-pipeline.ts      # Automated self-audit & pipeline integration test (34 test cases)
└── src/
    ├── index.ts              # Entry point utama userbot daemon
    ├── server.ts             # HTTP server Express & Premium UI Dashboard (Health, Status, Engines)
    ├── config.ts             # Konfigurasi aman & sanitasi rahasia
    ├── logger.ts             # Logger terstruktur dengan proteksi redaksi credential
    ├── types.ts              # Definisi interface & type TypeScript
    ├── bot/
    │   ├── client.ts         # Inisialisasi GramJS TelegramClient & auth checker
    │   ├── handler.ts        # Event listener pesan, perintah (.dl, .status, .ping), & kirim video
    │   └── progress.ts       # Message editor dengan proteksi anti-flood limit Telegram
    ├── engines/
    │   ├── base.ts           # Abstract base class untuk download engine
    │   ├── direct-engine.ts  # Engine 1: Direct stream & Cheerio HTML parser
    │   ├── playwright-engine.ts # Engine 2: Generic fallback sniffer & downstream delegate
    │   ├── streamlink-engine.ts # Engine 3: Streamlink runner (max 720p)
    │   ├── ytdlp-engine.ts   # Engine 4: yt-dlp fragment downloader (max 720p)
    │   ├── ffmpeg-engine.ts  # Engine 5: FFmpeg direct HLS remuxer
    │   ├── retry-engine.ts   # Engine 6: Secondary discovered media retry
    │   └── orchestrator.ts   # Fallback pipeline orchestrator
    ├── queue/
    │   └── download-queue.ts # Antrian konkurensi, isolasi temp dir, & timeout watcher
    └── utils/
        ├── cleaner.ts        # Pembersih proses & folder temporary per job
        ├── ffmpeg.ts         # Media probing, thumbnail maker, & MP4 remuxer
        ├── system.ts         # Deteksi path binary & lingkungan Termux/PRoot ARM64
        ├── translator.ts     # Metadata translator & formatter judul
        └── url-extractor.ts  # Deteksi & parser regex URL dari pesan
```

---

## 🛠️ 3. Perbaikan Lingkungan Sistem & Dependency (Setup & Installation)

Proyek ini telah dilengkapi dengan patch otomatis untuk mengatasi dua masalah utama pada instalasi Termux & Ubuntu PRoot:

### 1. Fix Error PNPM (`ERR_PNPM_IGNORED_BUILDS`)
- **Penyebab**: PNPM v12 secara default memblokir build scripts native dependencies (`esbuild`, `bufferutil`, `utf-8-validate`).
- **Solusi Otomatis**:
  - Dikonfigurasi `pnpm.onlyBuiltDependencies` di `package.json` untuk mengizinkan dependensi native secara eksplisit.
  - Perintah `pnpm approve-builds --all` otomatis dieksekusi di dalam `up.sh` dan `scripts/setup.sh` sebelum dan sesudah `pnpm install`.
  - `.npmrc` diatur dengan `ignore-scripts=false`.

### 2. Fix Chromium Launch (Bypass Snap di PRoot Termux ARM64)
- **Penyebab**: Paket `chromium-browser` bawaan `apt` di Ubuntu PRoot adalah *Snap wrapper* yang selalu gagal dijalankan di Termux karena tidak adanya daemon systemd/snapd.
- **Solusi Otomatis**:
  - Script installer (`scripts/setup.sh` & `up.sh`) otomatis menambahkan repository **Debian Bookworm**:
    ```bash
    echo "deb [trusted=yes] http://deb.debian.org/debian bookworm main" > /etc/apt/sources.list.d/debian-bookworm.list
    ```
  - Dikonfigurasi *apt pinning* di `/etc/apt/preferences.d/chromium.pref` agar hanya Chromium dan library terkait yang diunduh dari Bookworm tanpa merusak paket Ubuntu lainnya.
  - Mengunduh dan memasang Chromium native `.deb` asli (arsitektur ARM64/x86_64).
  - File `.env` otomatis terkonfigurasi dengan:
    ```env
    CHROMIUM_PATH=/usr/bin/chromium
    ```

---

## ⚡ 4. Logika Pipeline Extractor Media (Engine 2 / Playwright Fix)

### Fix Error `[EXTRACTOR_UNSUPPORTED]` pada Intercepted M3U8
- **Penyebab Sebelumnya**:
  Pada Engine 2 (Playwright + Chromium Discovery), network interception berhasil menangkap URL M3U8 (`.m3u8` atau MIME `application/vnd.apple.mpegurl`), namun sebelumnya engine hanya mengembalikan `success: false` ke orchestrator. Jika website tersebut tidak didukung oleh plugin Streamlink atau yt-dlp, sistem melempar error `[EXTRACTOR_UNSUPPORTED]`.
- **Solusi (Generic Fallback Pipeline)**:
  1. Engine 2 kini bertindak sebagai **Generic Fallback Downloader**.
  2. Saat listener `request` atau `response` Playwright mengintersepsi URL mengandung `.m3u8` atau Content-Type `application/vnd.apple.mpegurl`:
     - URL, custom headers (Referer, User-Agent, Authorization), dan cookies langsung disimpan ke context task.
     - Chromium segera ditutup untuk membebaskan alokasi memori RAM.
     - URL M3U8 tersebut **langsung diteruskan** ke downstream downloader (FFmpeg HLS remuxer ➔ yt-dlp generic ➔ Streamlink).
  3. Jika M3U8 telah berhasil didapatkan dari jaringan, sistem **dilarang keras** mengembalikan error `EXTRACTOR_UNSUPPORTED`. Downloader downstream langsung merangkai segmen TS menjadi file MP4 Telegram yang valid dan mengembalikan `success: true`.

---

## 🚀 5. Panduan Instalasi & Penggunaan

### Langkah A: Di Lingkungan Termux (Android)
```bash
# 1. Update Termux & pasang proot-distro
pkg update -y && pkg upgrade -y
pkg install -y git nodejs-lts pnpm ffmpeg python proot-distro

# 2. Pasang & masuk ke Ubuntu PRoot
proot-distro install ubuntu
proot-distro login ubuntu
```

### Langkah B: Di Lingkungan Ubuntu PRoot (atau Linux Server)
```bash
# 1. Jalankan script setup instan (otomatis PNPM approval, Debian Chromium, FFmpeg, yt-dlp)
bash up.sh
# atau:
bash scripts/setup.sh

# 2. Cek kesiapan sistem & diagnostik
pnpm doctor

# 3. Login akun Telegram (CLI Interaktif)
pnpm run login
```

### Langkah C: Menjalankan Bot & Dashboard
- **Menjalankan Userbot Daemon**:
  ```bash
  pnpm start
  ```
- **Menjalankan Dashboard Promosi & Telemetri**:
  ```bash
  pnpm dev
  ```
- **Menjalankan Test Suite Otomatis**:
  ```bash
  pnpm test
  ```

---

## 💬 6. Perintah Telegram Userbot

Kirim pesan ke **Saved Messages**, obrolan pribadi, atau grup yang diizinkan:
- `.dl <url>` : Unduh video dari URL/halaman web dengan pipeline multi-layer fallback 6 lapis.
- `.status` : Tampilkan status antrian download, kapasitas slot, dan uptime.
- `.ping` : Uji latensi respons userbot ke server Telegram.
- `.help` : Menampilkan petunjuk penggunaan dan sintaks perintah.
- *(Opsional)*: Cukup kirim tautan video langsung ke *Saved Messages*, bot akan otomatis mendeteksi dan mengunduhnya.

---

## 🧪 7. Hasil Pengujian Sistem
- **Self-Audit Test Suite**: 34/34 Test Suites **PASSED** (0 Failed).
- Validasi URL parser, direct streams, Playwright interceptor, FFmpeg transcoding, faststart remuxing, thumbnail generator, proteksi debounced progress, dan pipeline fallback handling.
