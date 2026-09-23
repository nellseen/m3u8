#!/usr/bin/env bash
# ==============================================================================
# Telegram Userbot Downloader - Comprehensive Environment Setup
# Compatible with: Termux, Ubuntu PRoot, Debian, Linux ARM64, and x86_64
# Idempotent: Safe to execute multiple times without re-installing existing tools
# ==============================================================================

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_ok() { echo -e "${GREEN}[OK]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_err() { echo -e "${RED}[ERROR]${NC} $1"; }

echo -e "${CYAN}======================================================"
echo -e " Telegram HLS/M3U8 Userbot - Environment Setup"
echo -e "======================================================${NC}"

# 1. Environment & Architecture Detection
IS_TERMUX=false
IS_PROOT=false
IS_UBUNTU_DEBIAN=false
HAS_ROOT=false
ARCH=$(uname -m)

if [ "$(id -u)" -eq 0 ]; then
  HAS_ROOT=true
fi

# Detect Termux
if [ -n "$PREFIX" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
  IS_TERMUX=true
  log_info "Environment: Native Termux ($PREFIX)"
elif [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
  log_info "Environment: Termux filesystem"
fi

# Detect OS
if [ -f "/etc/os-release" ]; then
  . /etc/os-release
  OS_NAME="${NAME:-Linux}"
  OS_ID="${ID:-linux}"
  log_info "OS: $OS_NAME ($OS_ID)"
  if [[ "$OS_ID" == "ubuntu" ]] || [[ "$OS_ID" == "debian" ]] || [[ "$ID_LIKE" == *"debian"* ]]; then
    IS_UBUNTU_DEBIAN=true
  fi
fi

# Detect PRoot
if grep -qa "proot" /proc/1/cmdline 2>/dev/null || [ -d "/dev/proot" ] || [ -n "$PROOT_PID" ]; then
  IS_PROOT=true
  log_info "Container: PRoot container detected"
fi

log_info "CPU Architecture: $ARCH"

# Detect Shell and target RC file
USER_SHELL=$(basename "${SHELL:-bash}")
SHELL_RC="$HOME/.bashrc"
if [ "$USER_SHELL" = "zsh" ] || [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ "$USER_SHELL" = "bash" ]; then
  SHELL_RC="$HOME/.bashrc"
else
  SHELL_RC="$HOME/.profile"
fi
log_info "Active Shell: $USER_SHELL (Config: $SHELL_RC)"

# Helper: Append to PATH safely without duplicates
add_to_path() {
  local DIR_PATH="$1"
  if [[ ":$PATH:" != *":$DIR_PATH:"* ]]; then
    export PATH="$DIR_PATH:$PATH"
  fi
  if [ -f "$SHELL_RC" ]; then
    if ! grep -q "$DIR_PATH" "$SHELL_RC" 2>/dev/null; then
      echo "export PATH=\"$DIR_PATH:\$PATH\"" >> "$SHELL_RC"
    fi
  fi
}

add_to_path "$HOME/.local/bin"
add_to_path "/usr/local/bin"

# Helper for package installation
pkg_install() {
  if [ "$IS_UBUNTU_DEBIAN" = true ]; then
    if [ "$HAS_ROOT" = true ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq || true
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" "$@"
    fi
  elif [ "$IS_TERMUX" = true ]; then
    pkg update -y || true
    pkg install -y "$@"
  fi
}

# 2. Check Existing Node.js (DO NOT reinstall if present)
log_info "Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  log_ok "Node.js already installed: $NODE_VER (skipping reinstallation)"
else
  log_err "Node.js is not found!"
  if [ "$IS_TERMUX" = true ]; then
    log_info "Installing Node.js via pkg..."
    pkg install -y nodejs
  elif [ "$IS_UBUNTU_DEBIAN" = true ]; then
    pkg_install nodejs
  fi
  if ! command -v node >/dev/null 2>&1; then
    log_err "Failed to install Node.js. Please install Node.js 18+ manually."
    exit 1
  fi
fi

# 3. Check and setup pnpm
log_info "Checking pnpm package manager..."
if command -v pnpm >/dev/null 2>&1; then
  log_ok "pnpm available: $(pnpm -v)"
else
  log_info "Installing pnpm..."
  if command -v corepack >/dev/null 2>&1; then
    corepack enable pnpm 2>/dev/null || true
  fi
  if ! command -v pnpm >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    if [ "$HAS_ROOT" = true ]; then
      npm install -g pnpm
    else
      npm install -g pnpm --prefix "$HOME/.local"
      add_to_path "$HOME/.local/bin"
    fi
  fi

  if command -v pnpm >/dev/null 2>&1; then
    log_ok "pnpm installed successfully: $(pnpm -v)"
  else
    log_err "Failed to install pnpm. Please run: npm install -g pnpm"
    exit 1
  fi
fi

# 4. Check and install FFmpeg & ffprobe
log_info "Checking FFmpeg and ffprobe..."
if command -v ffmpeg >/dev/null 2>&1; then
  FF_VER=$(ffmpeg -version 2>/dev/null | head -n 1)
  log_ok "FFmpeg available: $FF_VER"
else
  log_info "FFmpeg missing. Installing..."
  pkg_install ffmpeg
  if command -v ffmpeg >/dev/null 2>&1; then
    log_ok "FFmpeg installed successfully."
  else
    log_err "Could not install FFmpeg."
    exit 1
  fi
fi

if command -v ffprobe >/dev/null 2>&1; then
  log_ok "ffprobe available: $(ffprobe -version 2>/dev/null | head -n 1)"
else
  log_warn "ffprobe binary not separated; fallback to ffmpeg probe active."
fi

# 5. Check Python3, pip, yt-dlp, and Streamlink
log_info "Checking yt-dlp & Streamlink..."
if ! command -v python3 >/dev/null 2>&1; then
  pkg_install python3 python3-pip
fi

if command -v yt-dlp >/dev/null 2>&1; then
  log_ok "yt-dlp available: $(yt-dlp --version 2>/dev/null)"
else
  log_info "Installing yt-dlp..."
  pip3 install --break-system-packages yt-dlp 2>/dev/null || pip3 install yt-dlp 2>/dev/null || true
  if ! command -v yt-dlp >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then
    mkdir -p "$HOME/.local/bin"
    curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$HOME/.local/bin/yt-dlp" 2>/dev/null || true
    chmod a+rx "$HOME/.local/bin/yt-dlp" 2>/dev/null || true
  fi
  if command -v yt-dlp >/dev/null 2>&1; then
    log_ok "yt-dlp installed: $(yt-dlp --version 2>/dev/null)"
  else
    log_warn "yt-dlp installation skipped or failed; fallback engines will be used."
  fi
fi

if command -v streamlink >/dev/null 2>&1; then
  log_ok "Streamlink available: $(streamlink --version 2>/dev/null || echo 'installed')"
else
  log_info "Installing Streamlink..."
  pip3 install --break-system-packages streamlink 2>/dev/null || pip3 install streamlink 2>/dev/null || true
  if command -v streamlink >/dev/null 2>&1; then
    log_ok "Streamlink installed: $(streamlink --version 2>/dev/null)"
  else
    log_warn "Streamlink installation skipped; will fallback to other engines."
  fi
fi

# 6. Install Node project dependencies via pnpm
log_info "Installing Node dependencies via pnpm..."
pnpm install

# 7. Multi-Layer Chromium Strategy & Auto-Fix
log_info "Executing Multi-Layer Chromium Strategy & Real Launch Tests..."

test_chromium_health() {
  local CUSTOM_PATH="$1"
  if [ -n "$CUSTOM_PATH" ]; then
    CHROMIUM_PATH="$CUSTOM_PATH" pnpm exec tsx -e "
      import { checkPlaywrightHealth } from './src/utils/system.ts';
      checkPlaywrightHealth('$CUSTOM_PATH').then(r => {
        if (r.success) process.exit(0);
        process.exit(1);
      }).catch(() => process.exit(1));
    " 2>/dev/null
  else
    pnpm exec tsx -e "
      import { checkPlaywrightHealth } from './src/utils/system.ts';
      checkPlaywrightHealth().then(r => {
        if (r.success) process.exit(0);
        process.exit(1);
      }).catch(() => process.exit(1));
    " 2>/dev/null
  fi
}

CHROMIUM_VERIFIED=false
VERIFIED_PATH=""

# Step 7a: Check configured or existing system chromium
SYSTEM_CHROME_CANDIDATES=(
  "/usr/bin/chromium"
  "/usr/bin/chromium-browser"
  "/usr/bin/google-chrome"
  "/data/data/com.termux/files/usr/bin/chromium"
  "/snap/bin/chromium"
)

for c_bin in "${SYSTEM_CHROME_CANDIDATES[@]}"; do
  if [ -x "$c_bin" ]; then
    log_info "Testing system Chromium candidate: $c_bin..."
    if test_chromium_health "$c_bin"; then
      log_ok "System Chromium verified functional: $c_bin"
      CHROMIUM_VERIFIED=true
      VERIFIED_PATH="$c_bin"
      break
    fi
  fi
done

# Step 7b: Try Playwright bundled Chromium
if [ "$CHROMIUM_VERIFIED" = false ]; then
  log_info "Checking Playwright bundled Chromium..."
  pnpm exec playwright install chromium 2>/dev/null || true

  if test_chromium_health ""; then
    log_ok "Playwright bundled Chromium verified functional."
    CHROMIUM_VERIFIED=true
    VERIFIED_PATH="bundled"
  fi
fi

# Step 7c: Auto-fix: Install system chromium and runtime libraries if bundled fails
if [ "$CHROMIUM_VERIFIED" = false ]; then
  log_info "Chromium launch test failed. Attempting auto-fix via package manager..."
  if [ "$IS_UBUNTU_DEBIAN" = true ]; then
    pkg_install chromium-browser chromium libasound2 libatk1.0-0 libnss3 libgbm1 libdrm2 libxcomposite1 libxdamage1 libxrandr2 libxfixes3 libpango-1.0-0 || true
  elif [ "$IS_TERMUX" = true ]; then
    pkg_install chromium || true
  fi

  # Retest after package install
  for c_bin in "${SYSTEM_CHROME_CANDIDATES[@]}"; do
    if [ -x "$c_bin" ]; then
      log_info "Testing newly installed candidate: $c_bin..."
      if test_chromium_health "$c_bin"; then
        log_ok "Auto-fix SUCCESS: System Chromium operational at $c_bin"
        CHROMIUM_VERIFIED=true
        VERIFIED_PATH="$c_bin"
        break
      fi
    fi
  done
fi

# Step 7d: Save verified path to .env if system path was chosen
if [ "$CHROMIUM_VERIFIED" = true ] && [ "$VERIFIED_PATH" != "bundled" ] && [ -n "$VERIFIED_PATH" ]; then
  log_info "Persisting working CHROMIUM_PATH to .env..."
  if [ -f ".env" ]; then
    if grep -q "^CHROMIUM_PATH=" .env 2>/dev/null; then
      sed -i "s|^CHROMIUM_PATH=.*|CHROMIUM_PATH=\"$VERIFIED_PATH\"|" .env
    else
      echo "CHROMIUM_PATH=\"$VERIFIED_PATH\"" >> .env
    fi
  fi
fi

if [ "$CHROMIUM_VERIFIED" = true ]; then
  log_ok "Chromium engine status: READY ($VERIFIED_PATH)"
else
  log_warn "CHROMIUM LAUNCH TEST FAILED on all candidates."
  log_warn "Playwright engine will report NOT READY, but direct HLS & FFmpeg will continue working."
fi

# 8. Create runtime directories
mkdir -p temp output logs
chmod 755 temp output logs 2>/dev/null || true

# 9. Create .env with smart defaults
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    log_ok "Created .env with default configurations."
  fi
fi

echo -e "${GREEN}======================================================"
echo -e " Setup completed!"
echo -e " Jalankan: pnpm doctor  (untuk memeriksa kesehatan sistem)"
echo -e " Jalankan: pnpm run login  (untuk menghubungkan userbot Telegram)"
echo -e "======================================================${NC}"
