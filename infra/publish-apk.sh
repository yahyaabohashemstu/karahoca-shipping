#!/usr/bin/env bash
# =============================================================================
# Stage a driver APK. Releasing it to drivers is a separate, deliberate act.
# =============================================================================
# Run from the repo root, on the machine that has the signing key.
#
#   infra/publish-apk.sh [--host root@178.104.204.111] [--dry-run]
#
# This puts a build on the server and tells nobody. It uploads two files that
# nothing reads yet —
#
#   karahoca-takip-<code>.apk   the build
#   latest.staged.json          the manifest describing it
#
# — and leaves the two names the fleet does read, karahoca-takip.apk and
# latest.json, exactly as they were.
#
# Releasing is a decision taken by an administrator pressing the button on
# https://track.karahoca.com/app, because a release goes out mid-shift to
# drivers on a road in northern Iraq and the person who chooses that moment is
# at a desk, not at a build machine. Pressing it renames the staged pair over
# the live ones, in an order that never lets the manifest promise a sha256 the
# download does not have — see ReleaseService.announce.
#
# None of this is deployed by pushing to main. The directory is a host bind
# mount, read-only into the nginx sidecar that serves it and read-write into
# the API that promotes it.
# =============================================================================
set -euo pipefail

HOST="${KH_HOST:-root@178.104.204.111}"
REMOTE_DIR=/opt/karahoca/downloads
APK_NAME=karahoca-takip.apk
MANIFEST_NAME=latest.json
STAGED_MANIFEST=latest.staged.json
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
# different key over the app already on a driver's phone — the update silently
# does nothing, on every device at once, and the only remedy is a fleet-wide
# uninstall that discards every buffered point that never reached the server.
# App Links verification breaks with it. See docs/08-signing-key-runbook.md.
NEW_SIGNER="$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null |
  sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
ssh "$HOST" "cat $REMOTE_DIR/$APK_NAME" >/tmp/kh-live.apk 2>/dev/null || true
LIVE_SIGNER="$("$APKSIGNER" verify --print-certs /tmp/kh-live.apk 2>/dev/null |
  sed -n 's/.*certificate SHA-256 digest: //p' | head -1)"
echo "  new  $NEW_SIGNER"
echo "  live ${LIVE_SIGNER:-(nothing published yet)}"
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
# url is the canonical filename, not the staged one: by the time any phone
# reads this manifest it will have been renamed into place.
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
say "4. Stage"
# -----------------------------------------------------------------------------
# Uploaded under a temporary name and renamed, even though nothing serves these
# two paths yet: the API reads latest.staged.json whenever an administrator
# opens the release panel, and a half-written file read at that moment is a
# panel offering a build that does not exist.
scp "$APK" "$HOST:$REMOTE_DIR/.staged-apk.incoming"
printf '%s\n' "$MANIFEST" | ssh "$HOST" "cat > $REMOTE_DIR/.staged-manifest.incoming"

ssh "$HOST" bash -s <<REMOTE
set -euo pipefail
cd $REMOTE_DIR
[ "\$(sha256sum .staged-apk.incoming | cut -d' ' -f1)" = "$SHA" ] || {
  echo "upload corrupted in transit" >&2; rm -f .staged-apk.incoming; exit 1; }

# The build the fleet is on, kept now rather than at release time — only this
# script writes here, so the live APK cannot change in between, and the release
# is what overwrites the canonical filename.
[ -f $APK_NAME ] && cp -p $APK_NAME karahoca-takip-$LIVE_CODE.apk.bak || true

mv .staged-apk.incoming karahoca-takip-$VERSION_CODE.apk
mv .staged-manifest.incoming $STAGED_MANIFEST
chmod 644 karahoca-takip-$VERSION_CODE.apk $STAGED_MANIFEST
# uid 1000 is the node user the api container runs as, and releasing is two
# renames it performs inside this directory. Root-owned files here are a
# release button that returns 500.
chown 1000:1000 karahoca-takip-$VERSION_CODE.apk $STAGED_MANIFEST
ls -l
REMOTE

# -----------------------------------------------------------------------------
say "5. Staged. Nobody has been told."
# -----------------------------------------------------------------------------
LIVE_NOW="$(curl -fsS "$BASE_URL/$MANIFEST_NAME" 2>/dev/null |
  sed -n 's/.*"versionName": *"\([^"]*\)".*/\1/p' | head -1)"
echo "  The fleet is still on ${LIVE_NOW:-nothing}."
echo
echo "  To release $VERSION_NAME ($VERSION_CODE): sign in to the dashboard as an"
echo "  administrator, open https://track.karahoca.com/app and press the release"
echo "  button. Only phones on an older build are notified."
