#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  CVForge — EC2 Asset Setup Script
#  Run once after uploading files to your EC2 instance:
#    bash setup.sh
#
#  What it does:
#    1. Downloads html2pdf.js bundle (PDF export dependency)
#    2. Downloads Plus Jakarta Sans woff2 font files
#    3. Verifies all files are present
#    4. Prints deployment summary
#
#  Requirements: curl, bash (pre-installed on Amazon Linux / Ubuntu)
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

# ── COLOURS ─────────────────────────────────────────────────────
GREEN='\033[0;32m'; BLUE='\033[0;34m'
YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $1"; }
info() { echo -e "${BLUE}→${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
err()  { echo -e "${RED}✗${NC} $1"; }

echo ""
echo -e "${BLUE}╔═══════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  CVForge EC2 Setup                    ║${NC}"
echo -e "${BLUE}╚═══════════════════════════════════════╝${NC}"
echo ""

# ── DETECT SCRIPT DIRECTORY ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JS_DIR="$SCRIPT_DIR/assets/js"
CSS_DIR="$SCRIPT_DIR/assets/css"
FONT_DIR="$SCRIPT_DIR/assets/fonts"

mkdir -p "$JS_DIR" "$CSS_DIR" "$FONT_DIR"

# ── 1. DOWNLOAD html2pdf.js ─────────────────────────────────────
info "Downloading html2pdf.js..."
HTML2PDF_URL="https://cdnjs.cloudflare.com/ajax/libs/html2pdf.js/0.10.1/html2pdf.bundle.min.js"
HTML2PDF_DEST="$JS_DIR/html2pdf.bundle.min.js"

if [ -f "$HTML2PDF_DEST" ] && [ "$(wc -c < "$HTML2PDF_DEST")" -gt 1000 ]; then
  ok "html2pdf.js already present ($(du -sh "$HTML2PDF_DEST" | cut -f1))"
else
  curl -fsSL "$HTML2PDF_URL" -o "$HTML2PDF_DEST"
  ok "html2pdf.js downloaded ($(du -sh "$HTML2PDF_DEST" | cut -f1))"
fi

# ── 2. DOWNLOAD PLUS JAKARTA SANS FONTS ─────────────────────────
info "Downloading Plus Jakarta Sans fonts..."

declare -A FONTS=(
  ["PlusJakartaSans-Light.woff2"]="https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NSQD.woff2"
  ["PlusJakartaSans-Regular.woff2"]="https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NSQ_EWA.woff2"
  ["PlusJakartaSans-Medium.woff2"]="https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NSQPGWAo.woff2"
  ["PlusJakartaSans-SemiBold.woff2"]="https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NSQOhWAo.woff2"
  ["PlusJakartaSans-Bold.woff2"]="https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NSQSgWAo.woff2"
  ["PlusJakartaSans-ExtraBold.woff2"]="https://fonts.gstatic.com/s/plusjakartasans/v8/LDIoaomQNQcsA88c7O9yZ4KMCoOg4IA6-91aHEjcWuA_KU7NSQW_WAo.woff2"
)

FONT_ERRORS=0
for FILENAME in "${!FONTS[@]}"; do
  DEST="$FONT_DIR/$FILENAME"
  URL="${FONTS[$FILENAME]}"
  if [ -f "$DEST" ] && [ "$(wc -c < "$DEST")" -gt 1000 ]; then
    ok "$FILENAME already present"
  else
    if curl -fsSL "$URL" -o "$DEST" 2>/dev/null; then
      ok "$FILENAME"
    else
      warn "$FILENAME — download failed (using system font fallback is fine)"
      FONT_ERRORS=$((FONT_ERRORS + 1))
    fi
  fi
done

if [ "$FONT_ERRORS" -gt 0 ]; then
  warn "$FONT_ERRORS font file(s) could not be downloaded."
  warn "The app will fall back to system-ui sans-serif font."
  warn "To fix: manually download Plus Jakarta Sans from fonts.google.com"
fi

# ── 3. VERIFY CRITICAL FILES ─────────────────────────────────────
echo ""
info "Verifying deployment files..."
ERRORS=0

check_file() {
  local path="$1"
  local min_size="${2:-100}"
  local name
  name="$(basename "$path")"
  if [ -f "$path" ] && [ "$(wc -c < "$path")" -gt "$min_size" ]; then
    ok "$name ($(du -sh "$path" | cut -f1))"
  else
    err "$name — MISSING or too small"
    ERRORS=$((ERRORS + 1))
  fi
}

check_file "$SCRIPT_DIR/index.html" 50000
check_file "$JS_DIR/html2pdf.bundle.min.js" 10000
check_file "$CSS_DIR/plus-jakarta-sans.css" 100

# ── 4. SET FILE PERMISSIONS ──────────────────────────────────────
echo ""
info "Setting file permissions..."
find "$SCRIPT_DIR" -type f -exec chmod 644 {} \;
find "$SCRIPT_DIR" -type d -exec chmod 755 {} \;
ok "Permissions set (files: 644, dirs: 755)"

# ── 5. PRINT SUMMARY ─────────────────────────────────────────────
echo ""
echo -e "${BLUE}─────────────────────────────────────────${NC}"
if [ "$ERRORS" -eq 0 ]; then
  echo -e "${GREEN}✓ Setup complete — all files ready${NC}"
  echo ""
  echo "  Next steps:"
  echo "  1. Configure nginx:  sudo cp cvforge.nginx.conf /etc/nginx/sites-available/cvforge"
  echo "                       sudo ln -s /etc/nginx/sites-available/cvforge /etc/nginx/sites-enabled/"
  echo "                       sudo nginx -t && sudo systemctl reload nginx"
  echo ""
  echo "  2. (Optional) Add SSL via Let's Encrypt:"
  echo "     sudo certbot --nginx -d yourdomain.com"
  echo ""
  echo "  3. Open in browser:  http://YOUR_EC2_PUBLIC_IP/"
else
  echo -e "${RED}✗ Setup finished with $ERRORS error(s) — check output above${NC}"
fi
echo -e "${BLUE}─────────────────────────────────────────${NC}"
echo ""
