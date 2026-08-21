#!/usr/bin/env bash
# =============================================================================
# Publish the driver APK, and the manifest the app checks against.
# =============================================================================
# Run from the repo root, on the machine that has the signing key.
#
#   infra/publish-apk.sh [--host root@178.104.204.111] [--dry-run]
#
# The fleet is sideloaded: no store, no update channel. Two files make an
# update reach a driver, and they have to move together —
#
#   karahoca-takip.apk   the build itself, at a filename the QR landing page
#                        and every printed dispatch note already point at
#   latest.json          what the app reads to find out it is out of date
#
# Publishing them separately is the failure this script exists to prevent: a
# manifest advertising a version the download does not contain sends every
# phone in the fleet to download 24 MB and install the build it already has,
# forever, because the version never changes.
#
# Neither file is deployed by pushing to main. The directory is a host bind
# mount into an nginx sidecar, outside the Coolify cycle entirely.
# =============================================================================
set -euo pipefail

HOST="${KH_HOST:-root@178.104.204.111}"
REMOTE_DIR=/opt/karahoca/downloads
APK_NAME=karahoca-takip.apk
MANIFEST_NAME=latest.json
BASE_URL="https://track.karahoca.com/downloads"
APK="android/app/build/outputs/apk/release/app-release.apk"
NOTES_FILE="android/release-notes.json"
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --apk) APK="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# The Android build tools are not on PATH on every machine that has the key.
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-D:/Android SDK}}"
BT="$(ls -d "$SDK"/build-tools/* 2>/dev/null | sort -V | tail -1)"
AAPT2="${AAPT2:-$BT/aapt2}"
APKSIGNER="${APKSIGNER:-$BT/apksigner}"
[ -x "$AAPT2" ] || AAPT2="$AAPT2.exe"
[ -f "$APKSIGNER" ] || APKSIGNER="$APKSIGNER.bat"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

[ -f "$APK" ] || { echo "no APK at $APK — run ./gradlew :app:assembleRelease" >&2; exit 1; }

# -----------------------------------------------------------------------------
say "1. What is in the build"
# -----------------------------------------------------------------------------
BADGING="$("$AAPT2" dump badging "$APK" | head -1)"
VERSION_CODE="$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<<"$BADGING")"
VERSION_NAME="$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING")"
SIZE="$(wc -c <"$APK" | tr -d ' ')"
SHA="$(sha256sum "$APK" | cut -d' ' -f1)"
echo "  $VERSION_NAME ($VERSION_CODE), $SIZE bytes"
echo "  sha256 $SHA"

# -----------------------------------------------------------------------------
say "2. Signature"
# -----------------------------------------------------------------------------
# The check that matters most. Android refuses to install an APK signed by a
# different key over the app already on a driver's phone — the update simply
# does nothing, on every device at once, and the only fix is a fleet-wide
# uninstall that discards every buffered point that never reached the server.
# App Links verification breaks with it. See docs/08-signing-key-runbook.md.
NEW_SIGNER="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null |
  sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
LIVE_SIGNER="$(ssh "$HOST" "cat $REMOTE_DIR/$APK_NAME" 2>/dev/null |
  { cat >/tmp/kh-live.apk; } && "$APKSIGNER" verify --print-certs /tmp/kh-live.apk 2>/dev/null |
  sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
echo "  new  $NEW_SIGNER"
echo "  live $LIVE_SIGNER"
if [ -n "$LIVE_SIGNER" ] && [ "$NEW_SIGNER" != "$LIVE_SIGNER" ]; then
  echo "  SIGNER MISMATCH — this build cannot install over the fleet. Stopping." >&2
  exit 1
fi

LIVE_CODE="$("$AAPT2" dump badging /tmp/kh-live.apk 2>/dev/null |
  sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" | head -1)"
if [ -n "$LIVE_CODE" ] && [ "$VERSION_CODE" -le "$LIVE_CODE" ]; then
  echo "  versionCode $VERSION_CODE is not above the live $LIVE_CODE — no phone would" >&2
  echo "  offer this as an update. Bump it in android/app/build.gradle.kts." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
say "3. Manifest"
# -----------------------------------------------------------------------------
NOTES='{}'
[ -f "$NOTES_FILE" ] && NOTES="$(tr -d '\n' <"$NOTES_FILE")"
PUBLISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MANIFEST="$(cat <<JSON
{
  "versionCode": $VERSION_CODE,
  "versionName": "$VERSION_NAME",
  "url": "$BASE_URL/$APK_NAME",
  "sha256": "$SHA",
  "sizeBytes": $SIZE,
  "publishedAt": "$PUBLISHED_AT",
  "notes": $NOTES
}
JSON
)"
echo "$MANIFEST"

if [ "$DRY_RUN" = 1 ]; then
  say "--dry-run: nothing uploaded"
  exit 0
fi

# -----------------------------------------------------------------------------
say "4. Upload"
# -----------------------------------------------------------------------------
# Never write straight over the live path. nginx serves these files while the
# copy is in progress, so a driver downloading at that moment gets a truncated
# APK that installs as a parse error. Rename on the same filesystem is atomic,
# and an in-flight download keeps the old inode and finishes cleanly.
scp "$APK" "$HOST:$REMOTE_DIR/.$APK_NAME.incoming"
printf '%s\n' "$MANIFEST" | ssh "$HOST" "cat > $REMOTE_DIR/.$MANIFEST_NAME.incoming"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $REMOTE_DIR
[ "\$(sha256sum .$APK_NAME.incoming | cut -d' ' -f1)" = "$SHA" ] || {
  echo "upload corrupted in transit" >&2; rm -f .$APK_NAME.incoming; exit 1; }
[ -f $APK_NAME ] && cp -p $APK_NAME karahoca-takip-$LIVE_CODE.apk.bak || true
# The APK first: for the few milliseconds between the two renames, a phone that
# reads the manifest must find the build it promises already in place.
mv .$APK_NAME.incoming $APK_NAME
mv .$MANIFEST_NAME.incoming $MANIFEST_NAME
chmod 644 $APK_NAME $MANIFEST_NAME
ls -l
REMOTE

# -----------------------------------------------------------------------------
say "5. What the world now sees"
# -----------------------------------------------------------------------------
curl -fsS "$BASE_URL/$MANIFEST_NAME"
SERVED="$(curl -fsS "$BASE_URL/$APK_NAME" | sha256sum | cut -d' ' -f1)"
echo
if [ "$SERVED" = "$SHA" ]; then
  echo "  the download matches the manifest"
else
  echo "  MISMATCH: served $SERVED, manifest says $SHA" >&2
  exit 1
fi
