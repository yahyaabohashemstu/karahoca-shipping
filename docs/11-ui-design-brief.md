# Design brief — KaraHoca shipment tracking

A complete specification of what the product must let people do, written for a
designer who is starting from a blank page. It describes needs, users,
scenarios, data and states. Apart from one stated constraint (§6.0) it
describes no layout, screen, component or visual style — those are yours to
invent.

---

## 1. What this product is

A Turkish detergent manufacturer in Gaziantep ships pallets of product by lorry
to customers in Iraq and Syria — a corridor of 800 to 1,400 km, crossing at
Habur, Cilvegözü or Öncüpınar, typically 1 to 3 days door to door.

The company does not own lorries and does not employ drivers. Every shipment is
carried by a **third-party haulage firm**, whose driver the company may never
have met, in a lorry the company does not control, on a phone the company does
not own.

The product answers one question continuously — *where is that load, and is
anything wrong with it* — and answers it for two completely different
audiences: the people who dispatch the shipment, and the customer waiting to
receive it.

The essential difficulty is that the company has **no authority over the thing
it is tracking**. It cannot mandate an app on a driver's phone, cannot demand a
password be remembered, cannot discipline a driver who closes the app. Every
design decision has to survive that.

---

## 2. The people

### 2.1 The dispatcher — the primary user

Works at a desk in the Gaziantep plant. Runs somewhere between a handful and
forty active shipments at once. Their day is:

- Booking loads onto carriers and handing over tracking
- Watching for anything going wrong
- Answering the phone when a customer asks where their goods are
- Chasing a carrier when a lorry goes quiet

They are not a computer specialist. They are fast at their own job and
impatient with software that makes them wait, hunt, or re-enter something the
system already knows. They keep this product open all day, often as one tab
among several, sometimes on a second monitor as a wall display.

Critically: **they are frequently interrupted.** A phone rings, and they need
to answer "where is order SIP-2026-0481" in under ten seconds while the customer
is on the line. Any design that requires them to remember where they were, or to
navigate three levels deep, fails at the exact moment it matters.

### 2.2 The manager / owner

Looks at the same system less often, for different reasons: which carrier is
reliable, which shipments were late, what to say in a rate negotiation. Wants
figures they can defend to a third party, not a dashboard of pleasant graphs.

### 2.3 The consignee — the customer receiving the goods

A purchasing manager or warehouse supervisor at a company in Erbil, Sulaymaniyah,
Mosul, Baghdad, Aleppo or Damascus. They have **no account and never will**.
They receive a single link — usually pasted into WhatsApp — and open it on a
phone, often on poor mobile data.

They want to know one thing: when will the lorry arrive, and is it still coming.
They are not interested in the system; they are interested in whether to send
their forklift crew home.

This person may not read Turkish. They very likely read Arabic. If they are in
Erbil they may read Kurdish, in Arabic script.

### 2.4 The driver — present but not a user of the website

A third-party driver, paid by the haulage firm. They install a small phone app
and start tracking. They interact with the website only at one moment: scanning
a printed code, which either opens the app or sends them to a page that tells
them how to install it.

They may be Turkish-, Arabic- or Kurdish-speaking. They are standing in a lorry
yard, possibly in the dark, possibly in a hurry, and the person who handed them
the code has already walked away.

### 2.5 Roles inside the company

Three levels of access must be expressible:

| Role | Can do |
|---|---|
| **Administrator** | Everything, including managing user accounts |
| **Dispatcher** | Create and manage shipments, hand over tracking, close or cancel shipments, issue and revoke customer links |
| **Viewer** | See everything, change nothing |

A Viewer must never be shown a control that will refuse them. Read-only means
the interface *looks* read-only, not that it argues afterwards.

---

## 3. The operating reality — constraints that shape everything

These are not preferences. Each has already broken something.

**Three languages, and the third one is two languages.**
The interface must exist in Turkish, Arabic and Kurdish.

- The staff-facing product and the driver app are read by people hired in
  Gaziantep, Şanlıurfa, Mardin and Şırnak, where Kurdish means **Kurmanji, in
  Latin script**.
- The customer-facing page is read in Erbil, where Kurdish means **Sorani, in
  Arabic script**, written right to left.

These two Kurdish languages are not interchangeable and their readers generally
cannot read each other's script. The design must not assume "Kurdish" is one
thing with one flag.

**Right-to-left is a layout, not a text direction.**
When Arabic (or Sorani) is chosen, the entire interface mirrors: reading order,
navigation, table column order, icon placement, the side a panel slides from.
Latin content embedded inside it — vehicle plates, order references, session
codes — must stay left-to-right and must not have its punctuation flipped.

**Numbers and dates are read differently and can be misread dangerously.**
A distance of 1,100 km written in the Turkish convention as "1.100" is read by
an Arabic-speaking reader as 1.1. A delivery time of 17:30 shown on a 12-hour
clock can be read as morning. Both of these have already caused real confusion.
Every quantity, distance, weight, date and time must be presented in the
conventions of the language being read — and times should be unambiguous.

**Light and dark.**
Used in a bright office by day and at 02:00 in a dim room. Both themes are
first-class; neither is an afterthought. A user switching between them must not
lose their place or their data.

**Sessions last a whole shift.**
The dispatcher's window stays open for eight to fourteen hours. Nothing may leak,
creep, drift, or gradually slow down. A view that is perfect for five minutes
and unusable after six hours is a failed view.

**Live data, arriving constantly.**
Vehicle positions update every few seconds. The interface must absorb that
without flickering, without stealing the user's scroll position, without moving
something under a cursor that was about to click it, and without making the page
feel busy when nothing important has changed.

**The connection is not guaranteed.**
Lorries drive through mountains and border queues with no coverage. The office
internet drops. The interface must always distinguish three different things
that look identical if you are careless:

1. The lorry is fine and stationary
2. The lorry's phone has lost signal
3. *Our* connection to the server has dropped and this screen is stale

Showing a frozen position as though it were live is the single most dangerous
thing this product can do.

**Modest hardware, modest bandwidth.**
The customer page in particular may be opened on a five-year-old Android phone
on 3G in a warehouse. It must be fast and light. The staff product runs on
ordinary office machines, some without capable graphics.

---

## 4. The domain — objects, vocabulary and relationships

This is the vocabulary the interface must speak. The words matter; these are the
words the staff already use.

### 4.1 Customer (consignee)

The company receiving the goods.

- A short **code** used in the company's own ERP system — the key everything is
  filed under, and it must never be duplicated or altered
- Trading name, contact person, phone, email
- City, region and **country** — chosen from a fixed list, never free text,
  because a country typed by hand as DE / DEU / Almanya / Germany makes every
  export report wrong
- A **default delivery point**: a map location plus an arrival radius. Orders for
  this customer inherit it, so it is entered once rather than per shipment

The country also decides which language the customer's tracking page opens in.
That consequence must be visible at the moment the country is chosen — nobody
would guess that a dropdown labelled "Country" decides whether a customer in
Erbil can read the page they are sent.

### 4.2 Order

One load to be shipped. Corresponds to a document in the company's ERP.

- An **order number** — the ERP reference, unique
- The customer it goes to
- A **destination**: label, address, map point, and an arrival radius in metres
- What is on the lorry: total weight, pallet count, a plain description, and
  optionally a list of product lines with quantities
- **Planned delivery date** — optional, and its absence is meaningful (see §7.4)
- A status: **Pending → Dispatched → In transit → Delivered**, or **Cancelled**

### 4.3 Carrier (haulage firm)

A third-party company that moves loads.

- Code, trading name, tax number, contact person and phone
- An agreed **service level in hours** — how long a delivery is expected to take
- A roster of **vehicles** (registration plate, make/model, capacity) and
  **drivers** (name, phone, and the last four digits of an identity document —
  deliberately partial, enough to verify a person at a gate, not enough to be a
  personal-data liability)
- Whether the firm is currently active

### 4.4 Tracking session

The heart of the product: one lorry carrying one order, from hand-over to
arrival. Created by a dispatcher, activated by a driver.

It carries:

- A short human-readable **reference**
- The order, the carrier, and a snapshot of the driver name, phone and vehicle
  plate *as they were at hand-over* — because the yard often swaps a driver at
  the last minute and the record must reflect who actually drove
- A **one-time code** the driver enters to bind their phone, with an expiry
- How often the phone should report position (see §4.6)
- A hard expiry, so a forgotten session cannot track someone indefinitely
- Everything measured during the journey: current position, speed, heading,
  accuracy, phone battery and charging state, total points recorded, points
  rejected, distance travelled, top speed, number of times an offline backlog
  was uploaded, the longest gap in coverage, and whether the position stream
  ever looked falsified

### 4.5 Session status

Eight states, each of which the interface must be able to show and explain:

| Status | Meaning |
|---|---|
| **Draft** | Being filled in, not yet issued |
| **Assigned** | Code issued, waiting for a driver to enter it |
| **Claimed** | A phone has bound itself, tracking not yet started |
| **Active** | Tracking is running, positions are arriving |
| **Paused** | The driver paused it — a break, an overnight stop |
| **Completed** | Delivered, or closed by a dispatcher |
| **Cancelled** | Aborted |
| **Expired** | The code was never used, or the session outlived its maximum life |

### 4.6 Reporting cadence

How often the driver's phone reports, chosen per shipment. There are two modes,
and the design must make the choice between them comprehensible:

- **By time** — report every N seconds while moving
- **By distance** — report every N metres travelled, with a floor on how often

Plus, in both modes, a slower interval used **while the lorry is stationary**, so
a parked lorry still says "I am here" without draining the battery.

The person choosing this is trading route detail against the driver's battery,
and the interface should tell them roughly what they are choosing — approximately
how many position records per hour, or per 500 km.

### 4.7 Signal freshness — distinct from session status

How recently a position arrived. This is a separate axis from status and both
must be visible at once: a session can be *Active* and *silent*.

| State | Meaning |
|---|---|
| **Live** | A position arrived within the last 90 seconds |
| **Delayed** | Last position 90 seconds to 10 minutes ago |
| **Stale** | Last position 10 minutes to 2 hours ago |
| **Lost** | More than 2 hours since the last position |
| **Not started** | The driver has never started tracking |
| **Paused** | The driver deliberately stopped reporting |

The last two are not failures and must not be dressed as alarms. A dispatcher
who is trained to ignore red will ignore the red that matters.

### 4.8 Alerts — the exception desk

The product raises alerts on its own. Six kinds, three severities
(**Information**, **Warning**, **Critical**):

| Alert | Raised when |
|---|---|
| **Signal lost** | No position for longer than this shipment's own tolerance |
| **Arrived** | The lorry entered the destination radius |
| **Battery low** | The phone will not survive the rest of the journey |
| **Fake location** | The position stream appears to be falsified |
| **Never started** | A code was handed over and tracking never began |
| **Stopped too long** | Stationary for a long time, far from the destination |

Alerts have a lifecycle: raised → optionally resolves itself → acknowledged by a
named person. "Someone has seen this" is different from "this is no longer
happening", and both matter. An alert that resolved on its own still needs to be
reviewable, because it is evidence.

### 4.9 Journey record

Everything the shipment leaves behind, needed both while running and afterwards:

- The full route travelled
- A timeline of events — started, paused, resumed, signal lost, signal
  recovered, network lost, offline backlog uploaded, battery low, fake location
  detected, permission revoked, phone killed the app, arrived, completed, and
  about a dozen more
- **Coverage gaps**: stretches where no position was recorded, with how long each
  lasted and how far the lorry moved during it — the difference between "parked
  at customs" and "the app was closed"
- A speed profile over time
- A raw data export, for a dispute

### 4.10 Customer link

A single URL, created per shipment, that lets the consignee watch without an
account.

- It expires, and it can be revoked instantly
- Two things are **off by default** and switched on deliberately: whether the
  customer can see the route travelled, and whether they can see the driver's
  name and phone number
- It records how many times it has been opened and when it was last opened —
  which is genuinely useful: a customer who has not opened it is about to
  telephone

---

## 5. Surfaces to design

Four distinct products, three of which are public. They do not need to look like
one another; the staff tool and the customer page have almost nothing in common
except the brand.

### A. The staff application — authenticated, used all day
### B. The customer tracking page — one link, no account, phone
### C. The driver hand-off page — reached by scanning a printed code
### D. The driver install page — reachable by a URL read aloud over a phone

---

## 6. The staff application — jobs and scenarios

Below are the things a dispatcher must be able to do. They are described as
jobs, not as pages; how they are grouped into screens is your decision — with
the single exception stated immediately below.

### 6.0 The one fixed constraint: the map is the ground

This is the only layout decision in this brief that is already made, and it is
not open to reinterpretation.

**The map is the floor of the staff application.** It is not a panel, a card, a
widget, a tile, or one region of a grid. It fills the entire working area of the
screen, edge to edge, and everything else in the product — the fleet list,
counts, filters, search, shipment details, alerts, navigation — sits *on top of*
it.

Why this is a requirement and not a preference:

- The dispatcher's question is almost always geographic. *Where is it. How far
  is left. Has it reached the border. Which two are nearest Mosul.* A map large
  enough to answer those without panning is doing the work. A map small enough
  to sit beside a table is decoration that must be opened before it becomes
  useful — and by then the phone call has already gone badly.
- The screen is open all day and glanced at from across the room. What is
  legible from two metres is a shape moving across a country, not a row of text.
- Nine lorries spread over a corridor of 800–1,400 km cannot be told apart in a
  quarter of a screen at any zoom that also shows where they are.
- Every other view in the product is entered from this one and returns to it. It
  is the resting state of the application, not one of its destinations.

What this forces you to design, rather than design around:

- **Anything overlaying the map must earn the pixels it covers.** Prefer
  surfaces that collapse, slide aside, or dismiss entirely. The dispatcher must
  be able to reach a completely unobstructed map in one action, and put
  everything back just as fast.
- **Overlays must stay readable over whatever is beneath them** — pale desert,
  dark night styling, dense city labels, empty terrain — without becoming opaque
  rectangles that simply recreate the panels a full-bleed map was meant to
  remove.
- **The map cannot be the last thing to load.** Something honest and geographic
  must be on screen before the shipment data arrives; a blank rectangle where
  the floor should be reads as a broken product (§9.1).
- **Full-bleed must never mean hidden.** If an overlay is open by default, the
  map must be visibly continuous beneath and around it, so it is obvious there
  is a map there and obvious how to get to it.
- The map is also where selection is answered: choosing a lorry anywhere in the
  product should be resolved on the map, not by leaving it.

The customer's page (§7) is the one place this does not apply — it is read on a
phone, not worked in. See §7.3.

### 6.1 Signing in

Email and password. No self-registration — accounts are created by an
administrator.

Requirements:
- A person whose session has expired should be returned to where they were,
  not dumped at a home screen
- A failed sign-in must say what to do next, and must never say which of the two
  fields was wrong
- The language must be choosable *before* signing in — an Arabic-speaking
  employee should not have to read a Turkish login screen to reach the setting

### 6.2 Seeing the whole fleet at once

**Scenario.** The dispatcher arrives at 08:00. Nine lorries are on the road.
Before doing anything else they want to know: is everything moving, and is
anything wrong.

Requirements:
- The **map** (§6.0) showing every active lorry in its real position, oriented
  the way it is travelling, with an obvious visual difference between a lorry
  reporting normally and one that has gone quiet. This is the screen itself, not
  an element on the screen
- A **list** of the same lorries, scannable without moving the mouse, and sorted
  so the ones needing attention are first — not alphabetically, and not by
  whichever arrived last. It lives *over* the map rather than beside it, and it
  must be possible to get it out of the way without losing your place in it
- Selecting a lorry in either place highlights it in the other
- A count of what matters: how many on the road, how many waiting for a driver
  to start, how many silent
- The ability to search across everything visible — plate, order number,
  customer name, driver name, carrier — and to filter to just the silent ones
- The map must be able to frame all lorries at once on demand, and must not
  fight the user for control of the viewport afterwards
- A way to clear every overlay at once and see nothing but the corridor — and to
  bring the working surfaces back in the same gesture

**On the map, for a selected lorry**, without leaving the screen: order number,
customer, driver and phone, distance travelled, distance remaining, how long
since the last position, and a way to reach the full record.

**Scenario — the phone rings.** A customer asks about a specific order. The
dispatcher must find it and read out its position in under ten seconds, from
whatever screen they happen to be on.

**Scenario — the connection drops.** The office loses internet. Positions stop
arriving. The screen must say so plainly and immediately, because a frozen map
that looks live is worse than a blank one. When the connection returns it should
recover on its own without a reload.

### 6.3 Reacting to something going wrong

**Scenario.** At 14:20 a lorry that has been reporting every ten seconds goes
silent. Twenty minutes later, an alert is raised. The dispatcher is looking at a
different screen.

Requirements:
- Alerts must reach the dispatcher **wherever they are in the product** — not
  only on a screen they happen to have open
- The unattended count must be visible at all times, and must be quiet when
  there is nothing to see. A permanent badge is a badge nobody reads
- Opening the alert must give, in one place, everything needed to act: which
  lorry, which order, which customer, which carrier, how long it has been
  silent, and **the driver's phone number as a single tap to call**
- Alerts that have resolved themselves must be visibly separated from those
  still open, and still readable
- Acknowledging must record who acknowledged it, and that name must be visible
  to colleagues — this is a shared desk, and two people ringing the same driver
  is a real cost
- Acknowledging many at once must be possible; a backlog of forty informational
  alerts must not require forty clicks

**Scenario — the 02:00 case.** Nobody is at the desk. The product cannot solve
this on screen, but it must not pretend the alert was seen. When the dispatcher
arrives at 08:00, it must be immediately clear what happened overnight, in what
order, and what is still unresolved.

### 6.4 Handing tracking to a driver

This is the most important flow in the product, and the one with the least
forgiving physical circumstances: a driver in a yard, engine running, with a
phone.

**Scenario.** A load is ready. The dispatcher picks the order, picks the carrier,
names the driver and the plate, chooses how often to report, and produces
something the driver can act on.

Requirements:
- The dispatcher must be able to complete this in one uninterrupted pass. Any
  step that requires leaving to create a missing customer, carrier or vehicle
  must offer to create it **in place** and return
- The output must be **all three of**:
  - A short code the driver can type, readable aloud down a phone line, in a
    character set that cannot be misheard (no ambiguity between O and 0, I and 1)
  - A scannable code that opens the app with the session already filled in
  - A printable sheet that can be handed over on paper
- The code must expire, and the expiry must be stated in the driver's terms
  ("valid until 18:00 today"), not as a duration to calculate
- The customer's tracking link is created at the same moment and must be
  offered for sending immediately — with one tap to send it by WhatsApp, and one
  to copy it
- If the wrong driver is given the code, the dispatcher must be able to void it
  and issue a new one, and must be told clearly that doing so disconnects the
  phone that already has it

**Scenario — nothing to dispatch.** A new installation has no customers, no
carriers and no orders. Every empty state must tell the user what to create
first and let them start it from there. "No results" is not an acceptable answer
to a person who has never used the product.

### 6.5 Watching and closing one shipment

**Scenario.** A dispatcher opens a specific shipment to see how it is going, or
to answer a question about it, or to close it after delivery.

Requirements — everything about one journey in one place:
- Current status and signal freshness, both, unambiguously
- The route travelled so far on a map, with the destination and its arrival
  radius shown
- Who and what: order, customer, carrier, driver, plate, phone
- The measured facts: positions recorded, distance, longest gap, offline
  uploads, points rejected, and whether fake locations were detected
- The phone's own condition: model, operating system, battery optimisation
  state, background-location permission — because when a driver says "the app
  was open", this is how you find out
- The event timeline, newest events findable without scrolling through a day
- Coverage gaps called out explicitly, each with duration and distance moved
- The customer links issued for this shipment, with view counts, and the ability
  to revoke
- A raw export for disputes

**Actions**, each of which must state its consequence before it happens, and
each of which must name the specific shipment — never "Are you sure?":
- Pause and resume tracking
- Close as delivered
- Cancel the shipment
- Issue a fresh driver code

**Scenario — playback.** After delivery, a customer disputes the arrival time.
The dispatcher must be able to replay the journey and read the position at a
chosen moment.

### 6.6 Managing the standing records

Customers, carriers, vehicles and drivers all need to be listed, searched,
created and edited.

Requirements:
- Search that tolerates how people actually type: accents omitted, the wrong
  case, the Turkish dotted and dotless I confused. Typing `istanbul` must find
  `İstanbul`, and `sisli` must find `Şişli`
- Identifier fields (customer code, carrier code, plate) must be stable,
  uppercase, and never silently transformed into characters the ERP does not use
- A customer's delivery point is chosen on a map — searched by name, clicked, or
  dragged — never typed as coordinates. The arrival radius must be shown as a
  real circle on that map, at true scale, so a 300 m radius over a warehouse is
  visibly different from a 3 km radius over a district
- Carriers own vehicles and drivers; adding one from within the carrier's record
  must not lose the dispatcher's place

### 6.7 Judging carrier performance

**Scenario.** The manager is renegotiating rates with a haulage firm next week
and needs figures that will survive being argued with.

Requirements:
- Per carrier: shipments carried, completed, on-time rate, average distance,
  average duration, longest coverage gap, telemetry sampling rate, and how many
  shipments showed signs of falsified location
- **Every percentage must show the population it was computed over.** "92%" is
  worthless in a negotiation; "11 of 12" is not
- A shipment with no planned delivery date is **not late** — it is unmeasurable,
  and must be excluded from the on-time rate rather than counted as a miss. The
  interface must say so, because a carrier who has never been late must not read
  0%
- Sampling rate is a measure of telemetry coverage, **not driver behaviour**, and
  the interface must prevent that misreading. A lorry legitimately waiting four
  hours at a border reports less often by design

### 6.8 Personal settings

- Switch language, with the choice remembered
- Switch light / dark, with the choice remembered
- Sign out
- Something a dispatcher can send to whoever supports them when a request fails —
  a plain, copyable record of what went wrong. Not a stack trace; something a
  non-technical person can paste into a message

---

## 7. The customer tracking page

A completely separate design problem. Treat it as a small, self-contained
product, because to the person reading it, that is what it is.

### 7.1 The situation

A purchasing manager receives a link in WhatsApp from their supplier. They open
it on a phone, at work, possibly on weak mobile data. They have never seen this
product before and will never create an account. They may open it once, or every
hour for two days.

They are judging the supplier by this page.

### 7.2 What it must answer, in order

1. **Is my shipment on its way?** — in one line, in plain words, above everything
2. **Where is it now?** — on a map
3. **When will it arrive?** — the planned delivery, and how far is left
4. **Is this the right load?** — order number, and what is on the lorry, so it
   can be checked against their own purchase order

### 7.3 Requirements

- **Opens in the reader's own language automatically.** The language should be
  inferred from the customer's country, because these links get forwarded and
  the device that opens one is often not the device it was sent to. A visible
  way to change language must exist regardless
- **The map is the largest single thing on the page.** It is not full-screen
  here, because this page is read top to bottom, once, and the status sentence,
  the arrival estimate and the load contents must not have to be hunted for. But
  it should be the first thing the eye lands on after that opening sentence, big
  enough to show the lorry's position relative to the destination at a glance,
  and expandable to fill the screen for a reader who wants to look properly
- Every state must be stated in words, not only implied by a colour or an icon:
  being prepared, about to depart, on the road, on a break, arrived, delivered,
  cancelled, tracking finished
- **Honest about staleness.** If the lorry has not reported for a while the page
  must say so and say why it might be — coverage on this corridor is genuinely
  patchy — rather than showing an old position as current
- The driver's name and phone, and the route travelled, appear **only if the
  dispatcher enabled them**. The page must be complete and unembarrassing
  without them
- Distances and times in the reader's own conventions, and unambiguous
- A page that has expired, been revoked, or was never valid must say which, in a
  language the reader can read, without blaming them, and without confirming to
  a stranger that the shipment exists
- Fast and light. This may be the only thing loading on a bad connection
- No account, no cookie banner, no chat widget, no newsletter

### 7.4 Scenarios

- **Nothing has started yet.** The shipment is booked but the driver has not
  begun. Say that, plainly, rather than showing an empty map
- **On the road, reporting normally.** The common case
- **On the road, gone quiet.** Say when the last position was and that the lorry
  may be out of coverage
- **Stopped.** A lorry parked at a border for six hours is normal. Do not make it
  look like a failure
- **Arrived.** The most important moment on the page
- **Delivered / finished.** Tracking has ended; say what to do next
- **Cancelled.** Say it, and say who to contact
- **Link expired or revoked.** Say it, and say how to get a new one

---

## 8. The driver-facing web surfaces

### 8.1 The hand-off page

Reached by scanning a printed code, or by opening a link sent by SMS.

- If the app is installed, the person should never see this page — the code
  should open the app with the session already filled in
- If it is not installed, this page is what they get, standing in a yard. It must
  do exactly two things: get them the app, and preserve the code so they do not
  have to re-scan
- It must work for a driver who reads Turkish, Arabic or Kurdish, and who may
  never have installed an app from outside a store

### 8.2 The install page

A short URL a dispatcher can read down a phone line to a stranded driver.

- Reachable without an account
- Says what the app is, who it is from, and why they are being asked to install
  it — a driver who is not an employee is entitled to that
- Step-by-step installation, assuming no technical knowledge and a phone that
  will warn them about installing from outside the store
- Names the permissions that will be requested and why, before they are asked

---

## 9. Cross-cutting requirements

### 9.1 States every view must handle

Design each of these; none may be an afterthought:

- **First use** — nothing exists yet. Say what to create first and offer to start
- **Empty by filter** — there is data, this filter matches none. Offer to clear it
- **Loading** — the shape of what is coming, not a blank area or a spinner alone
- **Partial** — some data arrived, some did not
- **Failed** — what failed, whether it is the user's problem, and a way to retry
- **Stale** — data is present but old, and the interface knows it
- **Denied** — this user may not do this. Say so before they try, not after
- **Too much** — hundreds of rows; the design must not assume ten

### 9.2 How much data actually exists

Two facts that should shape the design more than they usually would.

**Today the system is nearly empty.** Production currently holds four orders and
ten shipments. A design that only looks composed once it is full is the wrong
design: the screens people see this month will have three rows in them. Empty
and sparse states are not edge cases here, they are the common case, and they
must look deliberate rather than broken.

**It must also survive being full.** The target is forty lorries reporting every
few seconds, and years of finished shipments. Both ends of that range must look
right.

**Old shipments lose their detail, on purpose.** Raw position records are kept
for two years and then discarded; a simplified version of the route is kept
forever. So a shipment from three years ago can still show the road the lorry
took, but cannot show speed over time, coverage gaps, or a replay. That view must
explain what is no longer available rather than presenting empty panels as
though something failed.

### 9.3 Density and scanning

The dispatcher's job is *scanning*, not reading. Forty rows should be
comparable at a glance. Generous whitespace that shows six rows per screen is
hostile to this user. Comfortable, not cramped — but information-dense.

Conversely, the customer's page is *read*, once, on a phone, by someone anxious.
It should be calm and spacious. These two requirements are in tension and should
not be resolved by a single style.

### 9.4 Numbers and identifiers

- Anything a person will compare down a column — quantities, distances, times —
  must align. Digits must not dance as values change
- Codes read aloud or typed — session codes, plates, order references — need a
  face where 0/O and 1/I/l cannot be confused
- An identifier is never translated, never re-cased, never reformatted

### 9.5 Live updates

- A position update must never move something a user is pointing at
- A list that reorders itself while being read is a bug, however correct the new
  order is
- Change should be perceptible without being loud. A dispatcher must be able to
  tell, peripherally, that data is flowing — and must never wonder whether the
  screen is frozen

### 9.6 Accessibility

- Every state distinguished by colour must also be distinguished by shape, text,
  or position. A red dot and a green dot are the same dot to a colour-blind
  dispatcher
- Contrast must hold in both themes
- The whole staff product must be operable from the keyboard, and the hand-off
  flow in particular should be completable without a mouse
- Text must survive being 40% longer, which is what Arabic and Kurdish will do to
  the Turkish

### 9.7 Destructive and irreversible actions

Cancelling a shipment, closing one as delivered, revoking a customer link, and
voiding a driver code are all irreversible or externally visible.

Each must state **what will happen**, naming the specific shipment, lorry or
customer — never a generic confirmation. "Are you sure?" is not a safeguard; it
is a reflex people learn to click through.

### 9.8 Trust and tone

The staff product is a working tool: precise, quiet, factual. It should never
congratulate the user, never use exclamation marks, and never hide a number
behind a friendly summary.

The customer page is the company's face. Calm, confident, specific. It is
answering someone who is mildly anxious about goods they have paid for.

---

## 10. Things that must never happen

Each of these has occurred, or nearly occurred, in this problem domain. Treat
them as hard constraints.

1. **A stale position shown as live.** If freshness is uncertain, say so.
2. **An alert that cannot be reached from the screen the user is on.**
3. **A percentage without its denominator** on any page used to judge a supplier.
4. **A confirmation dialog that does not name what it is about to affect.**
5. **An identifier silently altered** by case conversion or formatting.
6. **A number formatted in the wrong language's convention.** 1.100 and 1,100
   mean different things to different readers.
7. **A screen that cannot be read in the reader's language** — especially an
   error screen, which is exactly when they need it most.
8. **A live list that reorders under the user's cursor.**
9. **A control shown to someone who is not allowed to use it.**
10. **An empty state that says only "no data".**
11. **A view that requires a page reload to recover** from a normal event such as
    switching theme or language.
12. **Treating a paused or not-yet-started shipment as an error.**
13. **The map treated as a component.** In the staff product it is the surface
    everything else lives on (§6.0). A map shrunk into a card beside a table is
    the design of a different product.

---

## 11. What success looks like

- A dispatcher answers "where is my order" in under ten seconds, from any screen
- A lorry going silent is noticed by the product, not by the customer
- A driver in a yard is tracking within two minutes of being handed a code,
  without anyone explaining the app to them
- A consignee in Erbil opens a link in Arabic or Kurdish and understands it
  without asking anyone
- A manager walks into a rate negotiation with figures the carrier cannot
  dismiss
- A dispatcher who has used it for eight hours has not once wondered whether the
  screen is still live
- One action clears the screen down to nothing but the map, and one action puts
  the working surfaces back

---

## 12. Deliverables requested

Design the four surfaces described in §5. For each:

- Every state listed in §9.1
- Light and dark
- Left-to-right and right-to-left
- Phone, tablet and desktop for the customer page; desktop-first for the staff
  product, but usable on a tablet in a warehouse office
- A component and token system consistent enough that a new screen can be built
  from it without inventing anything

For the staff product specifically, show the two extremes of §6.0 together: one
frame with the map completely unobstructed, and one with every overlay open at
once. Both have to be something someone would want to sit in front of for eight
hours.

Brand: the company is **KaraHoca**. Industrial, Turkish, unglamorous, competent.
It sells detergent by the pallet and is trusted with other people's freight. The
design should look like a serious instrument rather than a consumer app, without
being drab.
