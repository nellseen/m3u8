#!/usr/bin/env bash
# ==============================================================================
# Telegram Userbot Downloader - Fast All-In-One Up Script
# Automates: PNPM approvals, Debian Chromium bypass, environment & dependency check
# ==============================================================================

set -e

CYAN='\033[0;36m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${CYAN}======================================================"
echo -e "   🚀 Telegram Userbot Downloader - Up & Setup"
echo -e "======================================================${NC}"

# 1. Auto-approve native dependencies for pnpm v12 (bypassing ERR_PNPM_IGNORED_BUILDS)
echo -e "${BLUE}[INFO]${NC} Approving native dependency build scripts for pnpm..."
if command -v pnpm >/dev/null 2>&1; then
  pnpm approve-builds --all 2>/dev/null || true
fi

# 2. Run comprehensive setup script
bash scripts/setup.sh "$@"

# 3. Ensure CHROMIUM_PATH=/usr/bin/chromium in .env
if [ -f ".env" ]; then
  if ! grep -q "^CHROMIUM_PATH=" .env 2>/dev/null; then
    echo 'CHROMIUM_PATH="/usr/bin/chromium"' >> .env
  elif grep -q '^CHROMIUM_PATH=""' .env 2>/dev/null || grep -q '^CHROMIUM_PATH=$' .env 2>/dev/null; then
    sed -i 's|^CHROMIUM_PATH=.*|CHROMIUM_PATH="/usr/bin/chromium"|' .env
  fi
fi

# 4. Final approval pass
if command -v pnpm >/dev/null 2>&1; then
  pnpm approve-builds --all 2>/dev/null || true
fi

echo -e "\n${GREEN}======================================================"
echo -e "   ✓ All systems verified and ready!"
echo -e "   • Diagnostik: pnpm doctor"
echo -e "   • Login Userbot: pnpm run login"
echo -e "   • Jalankan Userbot: pnpm start"
echo -e "   • Jalankan Dashboard: pnpm dev"
echo -e "======================================================${NC}\n"
