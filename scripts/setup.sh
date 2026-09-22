#!/usr/bin/env bash
# ==============================================================================
# Telegram Userbot Downloader - Auto Setup Script
# Compatible with: Termux, Ubuntu in PRoot, Debian, and Linux environments
# Idempotent: Safe to execute multiple times without re-installing existing tools
# ==============================================================================

set -e

# ANSI Colors for clean output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_ok() {
  echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_err() {
  echo -e "${RED}[ERROR]${NC} $1"
}

echo -e "${CYAN}======================================================"
echo -e " Telegram HLS/M3U8 Userbot - Environment Setup"
echo -e "======================================================${NC}"

# 1. Detect OS and Environment
IS_TERMUX=false
IS_PROOT=false
IS_UBUNTU_DEBIAN=false
HAS_ROOT=false

if [ "$(id -u)" -eq 0 ]; then
  HAS_ROOT=true
fi

if [ -n "$PREFIX" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
  IS_TERMUX=true
  log_info "Environment detected: Native Termux ($PREFIX)"
elif [ -d "/data/data/com.termux" ]; then
  IS_TERMUX=true
  log_info "Environment detected: Termux filesystem"
fi

if [ -f "/etc/os-release" ]; then
  . /etc/os-release
  OS_NAME="${NAME:-Linux}"
  OS_ID="${ID:-linux}"
  log_info "OS detected: $OS_NAME ($OS_ID)"
  if [[ "$OS_ID" == "ubuntu" ]] || [[ "$OS_ID" == "debian" ]]; then
    IS_UBUNTU_DEBIAN=true
  fi
fi

# Detect PRoot
if grep -qa "proot" /proc/1/cmdline 2>/dev/null || [ -d "/dev/proot" ] || [ -n "$PROOT_PID" ]; then
  IS_PROOT=true
  log_info "Runtime container: PRoot container detected"
fi

# 2. Check Node.js (DO NOT reinstall if present)
log_info "Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v)
  log_ok "Node.js is already installed: $NODE_VER (skipping Node installation)"
else
  log_err "Node.js is not found in PATH!"
  if [ "$IS_TERMUX" = true ]; then
    log_info "Installing Node.js via pkg..."
    pkg update -y && pkg install -y nodejs
  elif [ "$IS_UBUNTU_DEBIAN" = true ]; then
    log_err "Please install Node.js using your distribution package manager."
    exit 1
  else
    log_err "Please install Node.js 18+ before running this setup."
    exit 1
  fi
fi

# 3. Check npm
log_info "Checking npm..."
if command -v npm >/dev/null 2>&1; then
  NPM_VER=$(npm -v)
  log_ok "npm is available: v$NPM_VER"
else
  log_err "npm is missing!"
  exit 1
fi

# 4. Check and install pnpm
log_info "Checking pnpm package manager..."
if command -v pnpm >/dev/null 2>&1; then
  PNPM_VER=$(pnpm -v)
  log_ok "pnpm is already installed: v$PNPM_VER"
else
  log_info "Installing pnpm globally via npm..."
  if [ "$HAS_ROOT" = true ]; then
    npm install -g pnpm
  else
    if command -v sudo >/dev/null 2>&1; then
      sudo npm install -g pnpm
    else
      npm install -g pnpm --prefix "$HOME/.local"
      export PATH="$HOME/.local/bin:$PATH"
    fi
  fi
  if command -v pnpm >/dev/null 2>&1; then
    log_ok "pnpm installed successfully: $(pnpm -v)"
  else
    log_err "Failed to install pnpm globally."
    exit 1
  fi
fi

# 5. Helper for running apt / package manager commands
run_apt() {
  if [ "$IS_UBUNTU_DEBIAN" = true ]; then
    if [ "$HAS_ROOT" = true ]; then
      DEBIAN_FRONTEND=noninteractive apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" "$@"
    elif command -v sudo >/dev/null 2>&1; then
      sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
      sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" "$@"
    else
      log_warn "Non-root without sudo: cannot run apt-get for: $*"
      return 1
    fi
  elif [ "$IS_TERMUX" = true ]; then
    pkg update -y && pkg install -y "$@"
  fi
}

# 6. Check and install FFmpeg
log_info "Checking FFmpeg..."
if command -v ffmpeg >/dev/null 2>&1; then
  FFMPEG_VER=$(ffmpeg -version 2>/dev/null | head -n 1)
  log_ok "FFmpeg is installed: $FFMPEG_VER"
else
  log_info "FFmpeg not found. Attempting installation..."
  if [ "$IS_UBUNTU_DEBIAN" = true ]; then
    run_apt ffmpeg
  elif [ "$IS_TERMUX" = true ]; then
    pkg install -y ffmpeg
  else
    log_err "Please install ffmpeg using your system package manager."
    exit 1
  fi

  if command -v ffmpeg >/dev/null 2>&1; then
    log_ok "FFmpeg installed successfully."
  else
    log_err "Failed to install FFmpeg."
    exit 1
  fi
fi

# 7. Check Python 3 & pip
log_info "Checking Python 3 and pip..."
if ! command -v python3 >/dev/null 2>&1; then
  log_info "Installing python3..."
  run_apt python3
fi

if ! command -v pip3 >/dev/null 2>&1 && ! python3 -m pip --version >/dev/null 2>&1; then
  log_info "Installing python3-pip..."
  run_apt python3-pip
fi

# 8. Check and install Streamlink
log_info "Checking Streamlink..."
if command -v streamlink >/dev/null 2>&1; then
  STREAMLINK_VER=$(streamlink --version 2>/dev/null || echo "detected")
  log_ok "Streamlink is already installed: $STREAMLINK_VER"
else
  log_info "Installing Streamlink via pip..."
  if pip3 install --break-system-packages streamlink 2>/dev/null || pip3 install streamlink 2>/dev/null || pip install streamlink 2>/dev/null; then
    log_ok "Streamlink installed via pip."
  else
    log_info "Trying apt-get for streamlink..."
    run_apt streamlink || log_warn "Could not install streamlink via apt."
  fi

  if command -v streamlink >/dev/null 2>&1; then
    log_ok "Streamlink verified: $(streamlink --version 2>/dev/null)"
  else
    log_warn "Streamlink binary not found in current PATH. Engine 3 fallback will attempt python3 -m streamlink if available."
  fi
fi

# 9. Check and install yt-dlp
log_info "Checking yt-dlp..."
if command -v yt-dlp >/dev/null 2>&1; then
  YTDLP_VER=$(yt-dlp --version 2>/dev/null || echo "detected")
  log_ok "yt-dlp is already installed: $YTDLP_VER"
else
  log_info "Installing yt-dlp via pip..."
  if pip3 install --break-system-packages yt-dlp 2>/dev/null || pip3 install yt-dlp 2>/dev/null || pip install yt-dlp 2>/dev/null; then
    log_ok "yt-dlp installed via pip."
  else
    log_info "Downloading standalone yt-dlp binary..."
    if command -v curl >/dev/null 2>&1; then
      INSTALL_DIR="/usr/local/bin"
      [ "$HAS_ROOT" != true ] && INSTALL_DIR="$HOME/.local/bin"
      mkdir -p "$INSTALL_DIR"
      curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "$INSTALL_DIR/yt-dlp"
      chmod a+rx "$INSTALL_DIR/yt-dlp"
      export PATH="$INSTALL_DIR:$PATH"
    fi
  fi

  if command -v yt-dlp >/dev/null 2>&1; then
    log_ok "yt-dlp verified: $(yt-dlp --version 2>/dev/null)"
  else
    log_err "Failed to install yt-dlp."
    exit 1
  fi
fi

# 10. Run pnpm install for project dependencies
log_info "Installing Node project dependencies via pnpm..."
pnpm approve-builds --all 2>/dev/null || true
pnpm install

# 11. Prepare Chromium / Playwright
log_info "Checking Chromium / Playwright setup..."
if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1; then
  CHROME_BIN=$(command -v chromium || command -v chromium-browser)
  log_ok "System Chromium found at: $CHROME_BIN"
fi

log_info "Ensuring Playwright Chromium browser is ready..."
# In PRoot or Termux, Playwright install might need specific flags or use system chromium
if pnpm exec playwright install chromium 2>/dev/null; then
  log_ok "Playwright Chromium browser installed/verified."
else
  log_warn "Playwright standard browser download had an issue; the userbot will fallback to system chromium binary."
fi

# 12. Create required runtime directories
log_info "Creating required directories..."
mkdir -p temp output logs
chmod 755 temp output logs 2>/dev/null || true
log_ok "Directories verified: ./temp, ./output, ./logs"

# 13. Create .env with smart defaults if missing
if [ ! -f ".env" ]; then
  if [ -f ".env.example" ]; then
    cp .env.example .env
    log_ok "Created .env with all automatic defaults pre-configured."
  fi
else
  log_ok ".env file exists and verified."
fi

# 14. Optional interactive prompt for API ID and HASH if terminal is interactive
if [ -t 0 ] && [ -f ".env" ]; then
  CURR_API_ID=$(grep -E "^TELEGRAM_API_ID=" .env | cut -d '=' -f2- | tr -d '"' | tr -d "'" | tr -d ' ')
  if [ -z "$CURR_API_ID" ]; then
    echo ""
    echo -e "${CYAN}Ingin memasukkan TELEGRAM_API_ID & TELEGRAM_API_HASH sekarang? (y/n): ${NC}"
    read -r WANT_INPUT
    if [[ "$WANT_INPUT" =~ ^[Yy]$ ]]; then
      echo -n "Masukkan TELEGRAM_API_ID: "
      read -r INPUT_ID
      echo -n "Masukkan TELEGRAM_API_HASH: "
      read -r INPUT_HASH
      if [ -n "$INPUT_ID" ] && [ -n "$INPUT_HASH" ]; then
        sed -i "s|^TELEGRAM_API_ID=.*|TELEGRAM_API_ID=\"$INPUT_ID\"|" .env
        sed -i "s|^TELEGRAM_API_HASH=.*|TELEGRAM_API_HASH=\"$INPUT_HASH\"|" .env
        log_ok "Kredensial API berhasil disimpan otomatis ke .env!"
      fi
    fi
  fi
fi

echo -e "${GREEN}======================================================"
echo -e " Setup completed successfully!"
echo -e " Seluruh environment sudah diisi otomatis dengan default terbaik."
echo -e " Cukup jalankan: pnpm run login (untuk menghubungkan akun Telegram Anda)"
echo -e "======================================================${NC}"
