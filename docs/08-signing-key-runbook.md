# 08 — The Android signing key

The single most irreplaceable artifact in this project. Not because it is
secret — because it is **unrecoverable**. Everything else here can be rebuilt
from the repository; this cannot.

---

## What it is

| | |
|---|---|
| File | `D:/karahoca/signing/karahoca-release.jks` (PKCS12) |
| Alias | `khtest` |
| Key | RSA 2048, SHA256withRSA |
| Subject | `CN=KaraHoca Build Verification, OU=Dev, O=KaraHoca, C=TR` |
| Valid | 2026-08-11 → **2036-08-08** |
| SHA-256 | `1A:2B:12:86:9E:96:9C:E6:07:AE:59:78:73:A8:83:C2:4A:D9:3E:C0:DF:C3:D8:24:3F:C0:07:C7:E8:3E:30:79` |

The Gradle build finds it through `android/keystore.properties` (git-ignored),
falling back to `KH_KEYSTORE_PATH` / `KH_KEYSTORE_PASSWORD` / `KH_KEY_ALIAS` /
`KH_KEY_PASSWORD` for CI. Use forward slashes in `storeFile`: a `.properties`
file treats `\` as an escape character, so `D:\karahoca` silently loads as
`D:karahoca`.

The subject line still says "Build Verification" because the key began life as
a throwaway. **Do not regenerate it to fix the wording.** A new key is a new
identity with every consequence listed below, in exchange for a string nobody
ever sees.

---

## Two things depend on it, and they fail differently

**1. Updates.** Android refuses to install an update signed by a different
key. The only remedy is uninstall-then-install, and uninstalling wipes the app's
data — including any location points still buffered on the phone and not yet
uploaded. That is the real cost of losing this key: not the inconvenience, the
silently discarded shipment data.

**2. The QR hand-off.** `https://track.karahoca.com/.well-known/assetlinks.json`
names this fingerprint. Android verifies the installed app against it before it
will open `/t/<code>` links directly. A fingerprint mismatch does not raise an
error anywhere — the QR simply starts opening Chrome again, and the only way to
notice is to test a scan.

---

## Backup

The `.jks` is itself strongly encrypted, so its bytes are safe to store
anywhere. **The password must live somewhere else.** A backup that carries both
together is not a backup, it is a second copy of the problem.

Required, at minimum:

1. Password manager entry — the file (or the base64 text beside it) as an
   attachment, and the password as the entry's password field.
2. An encrypted copy on company storage, password not included.
3. One offline copy that is not on the build machine.

`karahoca-release.jks.base64.txt` sits next to the keystore for exactly this:
it turns "find and attach a binary file" into a copy-paste, which is the step
people actually complete. Restore with:

```bash
base64 -d body-only.txt > karahoca-release.jks
```

---

## Rotating to a new key

Possible **only while the current key still exists**. It is a planned upgrade,
not a recovery procedure. Once the key is gone, rotation is gone with it — which
is the strongest argument for the backup discipline above.

This procedure was rehearsed end to end on 2026-08-12 against the real APK; the
output below is measured, not assumed.

```bash
# 1. proof-of-rotation: the old key signs an attestation of the new one
apksigner rotate --out lineage.bin \
  --old-signer --ks karahoca-release.jks --ks-key-alias khtest \
  --new-signer --ks successor.jks       --ks-key-alias khnext

# 2. sign with BOTH signers; the lineage tells the platform how they relate
apksigner sign --lineage lineage.bin \
  --ks karahoca-release.jks --ks-key-alias khtest \
  --next-signer --ks successor.jks --ks-key-alias khnext \
  app-release.apk
```

`apksigner verify --print-certs -v` on the result reports:

```
Signer (minSdkVersion=24, maxSdkVersion=32)  → OLD key
Signer (minSdkVersion=33, maxSdkVersion=…)   → NEW key
```

**Read that carefully.** One APK, two signers. Android 8–12 phones install and
verify with the old key; Android 13+ with the new one. `apksigner` defaults
`--rotation-min-sdk-version` to 33 because rotation was unreliable on earlier
platforms. Nobody has to uninstall anything.

The consequence for App Links: during and after a rotation the fleet genuinely
presents **two different signers for the same build**, so
`session.androidCertFingerprints` (in `apps/api/src/config/configuration.ts`,
overridable with `ANDROID_CERT_SHA256`) must list both. It is an array for this
reason. Drop the old entry only once no phone in the fleet runs a build that
predates the rotation.

---

## If the key is lost anyway

1. Generate a new key; back it up properly this time.
2. Put the new fingerprint in `ANDROID_CERT_SHA256` and redeploy — five minutes.
3. Publish the new APK.
4. Every driver phone: **uninstall, then install.** Before they do, get them on
   Wi-Fi and let the app drain its buffer, or those points are gone.

Step 4 is the whole reason this document exists.
