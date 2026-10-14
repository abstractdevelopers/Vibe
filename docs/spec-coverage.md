# Spec coverage — VIBE v1.0

Where the implementation stands against the product specification, section by
section. This is an honest map, not a marketing one: it separates what is built
and verified from what is a boundary or a stub, and from what the spec itself
puts in a later phase.

Legend: **Built** — implemented and exercised. **Stub** — an integration
boundary with safe behaviour, per the spec's VERIFY rule. **Deferred** — the
spec places this in a later phase or explicitly out of V1.

## §0 Product principles

| Principle | Status |
| --- | --- |
| Social utility before monetization | Built — no ads or checkout in the slice |
| Participation over passive scrolling | Built — posts carry poll/plan/split activities |
| One connected journey | Partial — discover → interact → coordinate → settle is closed; "remember" is deferred |
| Fast and resilient | Built — optimistic reactions, server confirmation for money |
| No fake payment state | Built — `payment_reported` and `payment_verified` are distinct everywhere |
| No accidental custody | Built — Vibe holds no balance; the client says so on the expense screen |
| Consent and privacy by default | Built — private Circles, opt-in toggles, block/report |
| Accessible and inclusive | Built — 44px targets, focus rings, reduced motion, labelled icons |
| No dark patterns | Built — no unpaid-member ranking; the waitlist is neutral |
| Smallest complete vertical slice | Built — every shown control is wired |

## §2 Information architecture

- Five-destination bottom nav (Home, Circles, Create, Explore, You) — **Built**.
- Inbox as a top-bar icon with unread badge — **Built** (`screens/Inbox.tsx`,
  backed by `/v1/notifications`).
- Shared Money as a contextual area from a Circle and the profile — **Built**
  as the expense breakdown; the label is "Shared money", never "Wallet".
- Home feed sections: For You / Following, Nearby opt-in — **Built** as
  filters; Nearby is off and does not request location.
- Feed item types: text, poll — **Built**. Image/video/carousel, debate, quiz,
  event, product/offer, shared memory — **Deferred** (Phase 4/3).
- Explore tabs and filters — **Partial**: the screen exists with categories;
  the backend has no discovery module yet, so it is presentational.
- Circle surface (overview, timeline, members, plans, shared money, settings) —
  **Built** except chat timeline and moderation settings, which are **Deferred**.

## §3 UI and visual system

- Tokens: the spec's palette is the starting point. The implementation deepens
  the ink ramp so content sits on a lit surface rather than flat #10111B, keeps
  coral as the expressive action and violet as the interaction accent, and
  reserves green/red for success/destructive. **Built**, contrast checked.
- Typography: the spec suggests Inter/Geist/system. The build uses Bricolage
  Grotesque (display) + Instrument Sans (body). This is a deliberate deviation
  for a more distinctive identity; both are highly readable. **Built**.
- 8-point spacing, 14–20px card radius, 12–16px button radius, 44px targets —
  **Built**.
- Skeletons, empty states with a next action, retry/offline — **Built** for
  skeletons and empty states; an explicit offline indicator is **Deferred**.
- Light and dark themes, remembered — **Built**.
- Subtle motion 120–220ms honouring reduced motion — **Built**.
- Icons: a consistent professional set (Lucide), not emoji. **Built**.

## §4 Core mechanics

- 4.1 Social graph: follow, block, mute, private profile audience — **Built**.
  Contact discovery is opt-in and never uploads an address book. **Built**.
- 4.2 Posts and feed: lifecycle, audience, server-side authorization, cursor
  pagination, reactions, comments — **Built**. Moderation states
  (`pending_review`, `limited`, `removed`) exist in schema; the client surfaces
  removal only. Ranking is recency-based — **Partial**.
- 4.3 Polls: server-enforced one-vote, reproducible results, realtime updates —
  **Built**. Debates, challenges, quizzes — **Deferred**.
- 4.4 Circles and permissions: roles, invite links, leave, audited admin
  actions — **Built**. Owner transfer and Circle deletion are **Deferred**.
- 4.5 Plans and events: states, UTC + IANA zone storage, RSVP states including
  waitlist — **Built**. Check-in QR and reservations — **Deferred** (Phase 4);
  the plan screen states that a plan is not a reservation.
- 4.6 Shared expenses: integer minor units, exact-sum allocations, the full
  allocation state machine, reported ≠ verified, idempotent reconciliation,
  reversing audit events, private to Circle members — **Built**.
- 4.7 Commerce and orders: order state machine, webhook verification,
  idempotency — **Stub**. The provider is a stub behind an interface; no real
  checkout is enabled. This is the spec's VERIFY boundary.
- 4.8 Advertising: the feed renders a Sponsored label with report controls —
  **Stub**. No campaign system or ad delivery is built.
- 4.9 Vibe Pass / IRL — **Deferred** (Phase 5).
- 4.10 AI assistance — **Deferred** (Phase 5).

## §5 Realtime and performance

- Realtime transport: WebSocket hub, server-authorized by Circle membership,
  unique event ids, client reconnect with capped exponential backoff and jitter
  — **Built**. Durable state stays in Postgres; realtime only signals change.
- Optimistic UI for safe actions (reactions) — **Built**. Money and attendance
  never complete optimistically — **Built**.
- Skeletons rather than spinners — **Built**. Cursor pagination — **Built** for
  the feed.
- Latency budgets, load tests, low-end Android/Nigerian-network measurement —
  **Deferred**: these need a measurement environment, and the spec says not to
  claim targets without measuring.

## §6 Architecture

Modular monolith with clear module boundaries, PostgreSQL source of truth,
Redis for ephemeral use, typed Fastify API — **Built**. Search is not yet
implemented beyond user lookup. Queue, CDN/media pipeline, observability stack
— **Deferred**.

## §7 API contracts

Versioned `/v1`, consistent error envelope with request id, cursor pagination,
idempotency keys on non-repeatable writes, server-side validation, per-object
authorization, audit logs — **Built**. OpenAPI schema publication — **Deferred**.

## §8 Trust, safety, compliance

Report from every surface, block/mute, moderation queue with actions and an
audit trail, no unpaid-member shaming — **Built**. Age assurance, retention
schedules, data export/deletion workflows, advertiser verification, and legal
review of Nigerian data-protection duties — **Deferred** and flagged for human
review, as the spec requires professional advice.

## §9 Admin console

A minimal moderation queue with reports, actions and an audit log — **Built**
(API + tests). The full staff console (lookup, appeals, merchant review,
campaign approval, dashboards) — **Deferred**.

## §10 Analytics

Event names are defined in the spec. Only the minimum is emitted and no message
bodies or payment data are logged — **Partial**. A full privacy-conscious
pipeline with retention policy — **Deferred**.

## §11 Testing and acceptance

- Functional acceptance criteria: signup/privacy, authorized audiences, no
  duplicate feed items, Circle create/invite/leave, server-enforced voting,
  plan RSVP, exact expense splits, reported-never-verified-without-source,
  duplicate webhook safety, private-content authorization, audited moderation —
  **Built and covered by tests**.
- Performance, load, device and network testing — **Deferred** (needs an
  environment).
- Security: IDOR/BOLA, webhook forgery, replay and idempotency are covered by
  tests. Dependency/secret scanning, pen-testing payment flows — **Deferred**.

## §12 Phased delivery

Phase 1 (social MVP) and Phase 2 (utility MVP) are the focus and are largely
**Built**. Phase 3 (commerce and advertising) is a **Stub** pending provider
approval. Phases 4 and 5 (IRL, Vibe Pass, AI) are **Deferred**.

## §13 Definition of done

A feature counts as done when the happy path works end-to-end, loading/empty/
error states exist, authorization is tested, accessibility is checked, and
tests cover transitions and duplicate events. The first-sprint slice meets this
bar. Areas that do not yet — offline indicators, full admin tooling, analytics
retention — are listed above rather than claimed.

## Explicitly out of V1 (not built, by design)

Vibe-held wallet or stored value; pooled funds; P2P transfers; lending,
interest, crypto or investment; paid votes, betting or gambling; hardware;
full 3D metaverse; automated ad exchange/RTB; unreviewed regulated-category
advertising; AI taking payment or booking actions without confirmation.
