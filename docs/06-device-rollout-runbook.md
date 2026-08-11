# Field Rollout Runbook — beating the OEM battery killers

The architecture handles Doze. It cannot, on its own, handle a Xiaomi phone
whose MIUI power manager kills foreground services on principle. **This document
is the difference between a system that works in testing and one that works on
the road.**

---

## Testing against a development server first

Before any of the field procedure below, you want the app talking to a dev API
on your own machine. Four things have to line up, and three of them fail
silently:

| # | Requirement | Symptom when wrong |
|---|---|---|
| 1 | API bound to `0.0.0.0`, not `127.0.0.1` | phone gets connection refused |
| 2 | Windows Firewall allows inbound TCP on the API port for **Private** networks | phone hangs then times out |
| 3 | APK built with `-PkhApiBaseUrlDebug=http://<LAN-IP>:4000/api/v1/` | app talks to `10.0.2.2`, the *emulator's* host alias, which means nothing on a real phone |
| 4 | Cleartext HTTP permitted for the LAN range | `CLEARTEXT communication not permitted` |

(1) and (3) are handled by `./scripts/dev-run.ps1 -Lan`, which prints your LAN
address and the exact Gradle command. (4) is handled by
`app/src/debug/res/xml/network_security_config.xml`, which permits cleartext to
private ranges **in debug builds only** — release stays TLS-only.

(2) needs one elevated command, once:

```powershell
# Run as Administrator
New-NetFirewallRule -DisplayName "KaraHoca dev API 4000" `
  -Direction Inbound -Protocol TCP -LocalPort 4000 -Action Allow -Profile Private
```

Then, on the phone (same Wi-Fi, and the Wi-Fi marked as a *Private* network on
the PC), open `http://<LAN-IP>:4000/api/v1/health` in Chrome. If that returns
JSON, the app will work.

### A trap: the debug package name

`applicationIdSuffix = ".debug"` means debug builds install as
`com.karahoca.tracker.debug`. The QR landing page's `intent://` fallback names
an exact package, so with the release name hardcoded it would refuse to open
the app you just installed. Set `DEEP_LINK_PACKAGE=com.karahoca.tracker.debug`
when running a dev API (`dev-run.ps1` does this for you). Typing the code by
hand always works regardless.

### Installing

```powershell
# USB, with Developer options -> USB debugging enabled
adb devices                       # confirm the phone is listed and authorised
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
adb logcat -s KH/Service KH/Repo KH/SyncWorker KH/Watchdog KH/Network
```

That `logcat` filter is the whole story of the app: service lifecycle, buffer
writes, upload results and watchdog firings. Keep it open during the first
field test.

Without USB, copy the APK to the phone over Bluetooth or a USB-storage transfer
and open it from the file manager (allow "install unknown apps" for that app).

---

## The 90-second install

For a driver at the gate. Do it once per phone, not once per trip.

1. **Install** — scan the QR on the dispatch note, or copy the APK over
   Bluetooth/hotspot. Allow "install from unknown sources" for the browser.
2. **Open the app**, enter the session code (or scan the QR again — the deep link
   fills it in).
3. **Work down the readiness checklist.** Every red item has an "Aç" button that
   opens the right settings screen. Do not skip the amber ones.
4. **Press TAKİBİ BAŞLAT.**
5. **Verify on the dashboard** that the truck appears green before it leaves the
   yard.

Step 5 is not optional. A dispatcher confirming a green marker takes ten seconds
and catches every misconfiguration this document exists to prevent.

---

## The permission checklist, and why each matters

| Item | If missing | Severity |
|---|---|---|
| **Location: Allow all the time** | No fixes at all | **Blocking** |
| **Background location** | Fixes stop when the screen locks or after a watchdog restart | Critical |
| **Notifications** | The FGS notification is suppressed; Android eventually reclaims the service | High |
| **Battery optimisation: exempt** | Doze throttles us, *and* background FGS restarts are refused on Android 12+ | **Highest** |
| **Exact alarms** | The watchdog degrades from ±0 s to ±9 min | Medium |
| **OEM autostart** | Vendor killer terminates us with no callback | **Highest on affected brands** |

Note that "Allow all the time" is a **two-step grant** on Android 11+: the app
asks for foreground location first, and the system only then offers the
"all the time" option in Settings. The checklist reflects that — never combine
the two requests, because Android silently denies both.

---

## Per-brand instructions

### Xiaomi / Redmi / POCO (MIUI, HyperOS) — the hardest

The most aggressive killer in common use. All four steps are required.

1. **Settings → Apps → Manage apps → KaraHoca Takip → Autostart → ON**
2. Same screen → **Battery saver → No restrictions**
3. **Settings → Battery → App battery saver → KaraHoca Takip → No restrictions**
4. **Open Recents, swipe down on the KaraHoca card → tap the padlock.**
   This "locks" the app so the memory cleaner will not kill it. Undocumented,
   unavoidable, and the step people forget.

If tracking still stops on MIUI, check **Settings → Battery → More settings →
Memory extension / Deep sleep** and exclude the app.

### Huawei / Honor (EMUI, HarmonyOS)

1. **Settings → Battery → App launch → KaraHoca Takip → Manage manually**
2. Enable all three toggles: **Auto-launch**, **Secondary launch**,
   **Run in background**
3. **Settings → Battery → More battery settings → Sleep mode → OFF**

### Oppo / Realme (ColorOS) and OnePlus (OxygenOS 12+)

1. **Settings → Battery → Background power consumption → KaraHoca Takip → Allow**
2. **Settings → Apps → App management → KaraHoca Takip → Battery usage →
   Allow background activity + Allow auto launch**
3. Recents → three dots on the card → **Lock**

### Vivo / iQOO (FuntouchOS, OriginOS)

1. **Settings → Battery → High background power consumption → enable for
   KaraHoca Takip**
2. **Settings → More settings → Applications → Autostart → ON**
3. **i Manager → App manager → Autostart manager → ON**

### Samsung (One UI) — usually cooperative

1. **Settings → Battery → Background usage limits → Never sleeping apps →
   add KaraHoca Takip**
2. Confirm it is **not** in "Sleeping apps" or "Deep sleeping apps"
3. **Settings → Battery → More battery settings → Adaptive battery → OFF**
   (or at least verify the app is excluded)

### Stock Android (Pixel, Nokia, Motorola, most Android One)

Battery-optimisation exemption alone is sufficient. This is why a Pixel is the
right phone to hand a driver if you get to choose.

---

## Deciding whether a phone is fleet-ready

Run this once per **model**, not per device, and record the result.

| # | Test | Expected | Fails if |
|---|---|---|---|
| 1 | Track 30 min, screen off, phone in a bag | Points at the configured interval throughout | Gaps > 2 min → autostart or battery settings |
| 2 | Swipe out of Recents | Notification survives, or returns within ~5 s | Gone for good → OEM killer, lock the app in Recents |
| 3 | Airplane mode 20 min, then off | Whole gap backfills within a minute | No backfill → check WorkManager/battery settings |
| 4 | Force-stop from Settings | Watchdog restores within 5 min | Never returns → exact alarms denied, or ROM cancels alarms on force-stop |
| 5 | Reboot | Tracking resumes automatically | No resume → autostart off |
| 6 | Drain battery flat, recharge, boot | Session resumes and backfills | — |
| 7 | Run 12 h continuously | < 35% battery on a healthy 4,000 mAh phone, no gaps > 5 min | Higher → increase `idleIntervalSec` |

Test 4 has a legitimate failure mode: on some ROMs, force-stop cancels the app's
alarms as well, and nothing short of the driver opening the app can recover it.
Document that per model rather than pretending otherwise — it is one of the few
cases the architecture genuinely cannot solve.

---

## Reading the dashboard when something goes wrong

Everything below is on the session detail page.

| Symptom | Look at | Likely cause |
|---|---|---|
| Marker frozen, session ACTIVE | Coverage gaps panel | Dead zone if the gap ends with a backfill; OEM kill if it ends with `SERVICE_RESTORED` |
| Gap with **no** `SERVICE_RESTORED` after it | Event timeline | Phone was off, or the app was force-stopped and never reopened |
| Repeated `SERVICE_KILLED` / `SERVICE_RESTORED` pairs | Device panel | Battery optimisation not exempt, or OEM autostart off |
| `BUFFER_OVERFLOW` | Event timeline | Offline for 30+ truck-days, or the buffer cap is misconfigured |
| Battery falling fast | Telemetry panel | `pingIntervalSec` too low for the route; raise `idleIntervalSec` |
| ⚠ Sahte konum | Telemetry panel | Mock-location app installed. Points are kept as evidence — escalate to the carrier |
| Session shows CLAIMED but never ACTIVE | Event timeline | Driver claimed the code but never pressed Start |

The **coverage gaps panel** is the tool that settles arguments: it shows exactly
when telemetry stopped, where the truck was, and how far it moved while dark.

---

## Talking to drivers

Three things worth saying out loud, in this order:

1. **"You can close the app. Tracking keeps running."** Otherwise they leave it
   open, the screen stays on, the battery dies by lunchtime, and they conclude
   the app is broken.
2. **"If you lose signal, nothing is lost. It sends everything when you're back
   in coverage."** The app says this on screen too, in the offline state — it is
   the message that stops a driver in a tunnel from force-stopping it.
3. **"Keep the phone on the charger."** Continuous GNSS is genuinely expensive.
   A €5 vent-mount charger per truck removes an entire class of failure.

What not to say: anything that frames this as monitoring the driver. It tracks
*the shipment*, the session dies when the delivery is done, and the app collects
no persistent identifier for the person carrying it. That is both true and worth
being explicit about — the third-party drivers running this are not KaraHoca
employees, and a tool they resent is a tool that gets force-stopped.
