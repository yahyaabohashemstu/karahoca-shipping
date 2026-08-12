# 10 — Product roadmap

Produced 2026-08-12 by mapping the whole system — schema, API, dashboard,
driver app and design documents — synthesising one diagnosis from the five
maps, then having four deliberately conflicting lenses (dispatcher, customer,
carrier accountability, reliability) propose independently. 31 candidates,
scored comparatively by a single judge so the ranking means something rather
than being four self-assessments side by side.

Impact is *how much this changes the daily reality of running shipments, or how
much it would impress a customer evaluating KaraHoca*. Effort is on this stack,
where half-built schema counts as cheap. Both out of 10.

The scale caveat that shaped every verdict: production holds four orders and
ten sessions. Anything that only pays off at volume is deferred unless it is
cheap now and expensive to retrofit later.

## Shipped 2026-08-12

- **The exception desk** — `kh.alerts` with a raise/resolve/acknowledge
  lifecycle, four detectors, a fleet-wide socket room, and the bell.
- **Consignee share links** — `/s/<token>`, hashed at rest, expiring,
  revocable, driver identity and route off by default.
- **IN_TRANSIT** — an order status that was in the enum and the filter dropdown
  and had never once been assigned.
- **The carrier scorecard arithmetic** — a real denominator, and a sampling
  rate that stops being presented as driver behaviour.

## Next — real value, not yet built

| Feature | Impact | Effort | Why not yet |
|---|---|---|---|
| Off-desk escalation — email now, SMS/WhatsApp when someone is paid to be woken | 7 | 5 | Merges the dispatcher lens's 'Off-desk escalation' with the delivery-worker and channel half of reliability's alert outbox. The argument is sound — the desk is empty 18:00 to 08:00 and trucks to Erbil drive all night, and learning about a dead phone at 02:1... |
| Arrival window / ETA | 8 | 7 | Merges the dispatcher lens's OSRM road ETA with the customer lens's lane-history window; they are the same output with different bases, and neither basis is available yet. The lane-history version needs a materialized view over completed sessions — there ar... |
| Session metrics ledger and a defensible carrier scorecard | 7 | 8 | The diagnosis is correct and worth acting on partially now: on-time filters on planned_delivery_at IS NOT NULL while the page divides by all completed sessions, so a carrier that was never late reads 0%, and avg_coverage_pct ignores idle_interval_sec so a l... |
| Proof of delivery capture and a branded delivery certificate | 8 | 9 | Commercially the strongest thing on the list — a geofence-timestamped arrival plus a named receiver, seal number and photo ends an Erbil short-delivery argument in one email, and no competitor shipping on a paper irsaliye can answer it in a tender. It is al... |
| Backfill reconciliation — recompute derived state when late points land | 6 | 5 | The three defects are all verified-by-inspection and genuinely perverse: the continuous aggregate's 3-hour start_offset silently omits exactly the dead-zone stretches from the record that is meant to outlive raw retention, largest_gap_sec only ever rises so... |
| Telemetry integrity record — separating no coverage from app killed | 5 | 5 | The device-side half is the genuinely unretrofittable part: NETWORK_LOST/RECOVERED are detected precisely by NetworkMonitor and only written to a log line, SERVICE_KILLED and BATTERY_LOW have enum values with no emitter, and once a gap has happened you can ... |
| Proactive consignee milestone notifications | 7 | 6 | The insight is right — the expensive moment in a delayed shipment is the customer discovering it themselves, and inverting that is what purchasing managers remember at renewal. But it is fourth in a dependency chain: it needs the share link (building now), ... |
| Arabic and multi-locale for customer- and driver-facing artefacts | 6 | 5 | The corridor argument is correct: an Erbil consignee handed a Turkish-only page reads it as somebody else's internal paperwork and phones anyway. But the version that matters — the share card in Arabic — is thirty strings and belongs inside the share-link f... |
| Delay attribution — cause codes on every stop | 6 | 5 | This is the feature that decides whether the scorecard survives its first meeting with a carrier — 'half of that is the border' is a true objection and today it cannot be answered. Seeding Habur, Cilvegözü and Öncüpınar as three rows in the already-complete... |
| Lane baselines and corridor benchmarking | 6 | 6 | Not wrong, just arithmetically impossible right now: percentile_cont over completed sessions per lane needs dozens of runs per lane and there are four orders in total. Everything it would output — p50/p90 transit, the per-carrier split, the p80 fallback SLA... |
| Carrier review pack with a working export | 4 | 5 | Two things bundled with very different urgency. The 401 evidence download is a defect — the NDJSON export is built, cursor-streamed and correct, and the UI renders it as a bare anchor with no Authorization header behind a fail-closed guard, so the one artef... |
| Per-customer service-level report | 4 | 3 | Cheap — it is one view and one printable page reusing the certificate styling — and the point about back-porting the corrected numerator so internal and external numbers cannot disagree in front of a customer is exactly right. But handing a consignee a serv... |
| Customer portal | 4 | 7 | The switching-cost argument is the best strategic reasoning in the whole candidate set, and the decision to keep portal identities out of kh.users is correct — the staff account store has no create-user, no disable-user and no password change, and grafting ... |

## Deliberately not building

| Feature | Impact | Effort | Why not |
|---|---|---|---|
| Saved views and the saved_views table | 2 | 3 | With four orders and ten sessions the entire fleet fits on one screen without scrolling — filters solve a problem that does not exist, and a saved-views table with seeded entries and live counts is furniture around an empty room. The genuinely cheap sub-par... |
| Route deviation and restricted-zone evidence | 3 | 7 | This is the most speculative item on the list. It requires lane corridors derived from lane baselines that cannot be computed (no history), it assumes a systematic unauthorised-detour problem that nothing in the data suggests exists, and the false-positive ... |
| Load and soak harness at 250 concurrent sessions | 3 | 5 | The three hot-path defects this proposal identified are real and I have promoted them into the storage-and-hot-path pass above — they were found by reading code, which is the point: the harness was not needed to find them and would not be needed to fix them... |

## Open decisions — all four closed 2026-08-13

- **SSH password authentication is off.** `PasswordAuthentication no` and
  `PermitRootLogin prohibit-password`, in `sshd_config.d/00-karahoca-hardening.conf`
  — named 00 so it beats cloud-init's drop-in, which sorts later and wins
  otherwise. Verified: a fresh key login succeeds, a password attempt gets
  `Permission denied (publickey)`. It cost nothing because nothing used it:
  zero successful password logins in every retained log. fail2ban added too,
  which banned two addresses within seconds of starting.

- **The Coolify UI is no longer public.** It is fully served over
  `https://coolify.karahoca.com`, and Traefik reaches it across the docker
  network rather than the published host port, so closing `:8000` to the
  internet cannot break it. Blocked in DOCKER-USER with
  `--ctorigdstport 8000` — the first two attempts silently did nothing, because
  Docker DNATs host 8000 to container **8080** and a `--dport 8000` rule never
  matches after that. The administrator's address is whitelisted as a way back
  in. Ports 6001/6002 are deliberately left open: `coolify-realtime` carries no
  Traefik labels, so the browser talks to it directly and blocking it would
  break deployment log streaming.

- **mail.karahoca.com was never a certificate problem.** KaraHoca's mail is
  Microsoft 365 — MX `karahoca-com.mail.protection.outlook.com` — and this box
  runs no mail service at all. The hostname was a stale A record pointing at a
  server that served nothing, so visitors got a self-signed placeholder and a
  404 from their own supplier's domain. It now has a real Let's Encrypt
  certificate and a 302 to Outlook webmail, via
  `/data/coolify/proxy/dynamic/mail-karahoca-redirect.yaml`. **The proper fix
  is still a DNS change** — delete the A record — which cannot be done from the
  server.

- **Backups are off-site.** See [09](09-backup-and-restore.md).
