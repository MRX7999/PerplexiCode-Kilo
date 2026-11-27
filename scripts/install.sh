#!/usr/bin/env bash
# PerplexiCode (Kilo Edition) installer for Antigravity IDE, VS Code, Cursor and Windsurf.
#
#   curl -fsSL https://raw.githubusercontent.com/MRX7999/PerplexiCode-Kilo/master/scripts/install.sh | bash
#
# Options:
#   --ide antigravity|code|cursor|windsurf|all   target editor (default: antigravity)
#   --version vX.Y.Z                             install a specific release (default: latest)
#   --vsix /path/to/file.vsix                    install a local VSIX instead of downloading
#   --sha256sums /path/to/SHA256SUMS.txt         verify a local VSIX against a checksum file
#   -h, --help                                   show this help
set -euo pipefail

REPO="MRX7999/PerplexiCode-Kilo"
ASSET="perplexicode-kilo.vsix"
SUMS_ASSET="SHA256SUMS.txt"
EXTENSION_ID="MRX7999.perplexicode-kilo"
IDE="antigravity"
VERSION="latest"
VSIX=""
SHA256SUMS_FILE=""

log()  { printf '\033[1;36m[perplexicode]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[perplexicode]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[perplexicode]\033[0m %s\n' "$*" >&2; exit 1; }

usage() { sed -n '2,12p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ide)          IDE="${2:-}"; shift 2 ;;
    --ide=*)        IDE="${1#*=}"; shift ;;
    --version)      VERSION="${2:-}"; shift 2 ;;
    --version=*)    VERSION="${1#*=}"; shift ;;
    --vsix)         VSIX="${2:-}"; shift 2 ;;
    --vsix=*)       VSIX="${1#*=}"; shift ;;
    --sha256sums)   SHA256SUMS_FILE="${2:-}"; shift 2 ;;
    --sha256sums=*) SHA256SUMS_FILE="${1#*=}"; shift ;;
    -h|--help)      usage; exit 0 ;;
    *) die "Unknown option: $1 (use --help)" ;;
  esac
done

# Candidate CLI locations per editor: PATH names first, then app bundles / package dirs.
candidates() {
  case "$1" in
    antigravity)
      printf '%s\n' antigravity-ide antigravity \
        "/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
        "$HOME/Applications/Antigravity IDE.app/Contents/Resources/app/bin/antigravity-ide" \
        "/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity" \
        "$HOME/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity" \
        /usr/share/antigravity-ide/bin/antigravity-ide /usr/share/antigravity/bin/antigravity \
        /opt/antigravity-ide/bin/antigravity-ide /snap/bin/antigravity-ide ;;
    code)
      printf '%s\n' code \
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
        "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
        /usr/share/code/bin/code /snap/bin/code ;;
    cursor)
      printf '%s\n' cursor \
        "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
        "$HOME/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
        /usr/share/cursor/bin/cursor /opt/Cursor/resources/app/bin/cursor ;;
    windsurf)
      printf '%s\n' windsurf \
        "/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" \
        "$HOME/Applications/Windsurf.app/Contents/Resources/app/bin/windsurf" \
        /usr/share/windsurf/bin/windsurf ;;
    *) return 1 ;;
  esac
}

find_cli() {
  local candidate
  while IFS= read -r candidate; do
    if [ "${candidate#/}" = "$candidate" ]; then
      if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
    elif [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"; return 0
    fi
  done < <(candidates "$1")
  return 1
}

editor_name() {
  case "$1" in
    antigravity) echo "Antigravity IDE" ;;
    code) echo "VS Code" ;;
    cursor) echo "Cursor" ;;
    windsurf) echo "Windsurf" ;;
  esac
}

case "$IDE" in
  antigravity|code|cursor|windsurf) TARGETS="$IDE" ;;
  all) TARGETS="antigravity code cursor windsurf" ;;
  *) die "Unsupported --ide '$IDE'. Use antigravity, code, cursor, windsurf or all." ;;
esac

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/perplexicode.XXXXXX")"
trap 'rm -rf "$WORKDIR"' EXIT

compute_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print tolower($1)}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{print tolower($NF)}'
  else
    die "Neither sha256sum, shasum nor openssl is available to verify SHA256."
  fi
}

verify_sha256() {
  local target_file="$1"
  local sums_file="$2"
  local asset_name="$3"
  [ -f "$sums_file" ] || die "SHA256SUMS file not found: $sums_file"
  local expected
  expected="$(awk -v name="$asset_name" '
    NF >= 2 {
      h = tolower($1)
      f = $2
      sub(/^\*/, "", f)
      sub(/^\.\//, "", f)
      if (f == name && h ~ /^[0-9a-f]{64}$/) {
        print h
        exit
      }
    }
  ' "$sums_file")"
  [ -n "$expected" ] || die "Entry for $asset_name not found in $sums_file"
  local actual
  actual="$(compute_sha256 "$target_file")"
  if [ "$actual" != "$expected" ]; then
    die "SHA256 mismatch for $asset_name: expected $expected, got $actual"
  fi
  log "SHA256 verified: $actual"
}

if [ -n "$VSIX" ]; then
  [ -f "$VSIX" ] || die "VSIX not found: $VSIX"
  FILE="$(cd "$(dirname "$VSIX")" && pwd)/$(basename "$VSIX")"
  if [ -n "$SHA256SUMS_FILE" ]; then
    verify_sha256 "$FILE" "$SHA256SUMS_FILE" "$(basename "$FILE")"
  fi
else
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if [ -n "${PERPLEXICODE_RELEASE_BASE_URL:-}" ]; then
    BASE_URL="${PERPLEXICODE_RELEASE_BASE_URL%/}"
  elif [ "$VERSION" = "latest" ]; then
    BASE_URL="https://github.com/$REPO/releases/latest/download"
  else
    case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
    BASE_URL="https://github.com/$REPO/releases/download/$VERSION"
  fi
  URL="$BASE_URL/$ASSET"
  SUMS_URL="$BASE_URL/$SUMS_ASSET"
  FILE="$WORKDIR/$ASSET"
  SUMS="$WORKDIR/$SUMS_ASSET"
  log "Downloading $URL"
  if [ -t 2 ]; then progress="--progress-bar"; else progress="--silent --show-error"; fi
  # shellcheck disable=SC2086
  curl -fL --retry 3 $progress -o "$FILE" "$URL" || die "Download failed: $URL"
  # shellcheck disable=SC2086
  curl -fL --retry 3 --silent --show-error -o "$SUMS" "$SUMS_URL" || die "SHA256SUMS download failed: $SUMS_URL"
  verify_sha256 "$FILE" "$SUMS" "$ASSET"
fi

# A VSIX is a zip that starts with "PK"; catches HTML error pages early.
[ "$(head -c 2 "$FILE")" = "PK" ] || die "Not a VSIX archive: $FILE"
PKG_VERSION=""
if command -v unzip >/dev/null 2>&1; then
  PKG_VERSION="$(unzip -p "$FILE" extension/package.json 2>/dev/null \
    | sed -n 's/^  "version": *"\([^"]*\)".*/\1/p' | head -n 1 || true)"
elif command -v python3 >/dev/null 2>&1; then
  PKG_VERSION="$(python3 -c 'import json,sys,zipfile; print(json.loads(zipfile.ZipFile(sys.argv[1]).read("extension/package.json"))["version"])' "$FILE" 2>/dev/null || true)"
fi
log "Package: $EXTENSION_ID${PKG_VERSION:+ $PKG_VERSION}"

installed=0
for target in $TARGETS; do
  name="$(editor_name "$target")"
  if ! cli="$(find_cli "$target")"; then
    [ "$IDE" = "all" ] || die "$name CLI not found. Install the editor or pass the VSIX by hand: Extensions view > ... > Install from VSIX..."
    continue
  fi
  log "Installing into $name ($cli)"
  # Antigravity prints a harmless "antigravityAnalytics ... NOT registered" line; trust the exit code.
  if ! out="$("$cli" --install-extension "$FILE" --force 2>&1)"; then
    printf '%s\n' "$out" | tail -n 15 >&2
    warn "$name: install failed"
    continue
  fi
  listed="$("$cli" --list-extensions --show-versions 2>/dev/null | grep -i "^$EXTENSION_ID@" || true)"
  if [ -n "$listed" ]; then
    log "$name: $listed"
  else
    log "$name: installed (run '$cli --list-extensions --show-versions' to confirm)"
  fi
  installed=$((installed + 1))
done

[ "$installed" -gt 0 ] || die "Nothing was installed."
log "Done. Reload the editor window: Cmd/Ctrl+Shift+P > Developer: Reload Window."
log "If the old PerplexiCode (perplexicode.perplexicode) is installed, PerplexiCode Kilo offers to import its accounts after the reload."
