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
| Social utility before monetization | Built — the social slice stands alone; commerce and campaigns are additive and labelled, never a prerequisite |
| Participation over passive scrolling | Built — posts carry poll/plan/split activities |
| One connected journey | Partial — discover → interact → coordinate → settle is closed; "remember" is deferred |
| Fast and resilient | Built — optimistic reactions, server confirmation for money |
| No fake payment state | Built — `payment_reported` and `payment_verified` are distinct everywhere |
| No accidental custody | Built — Vibe holds no balance; the client says so on the expense screen |
| Consent and privacy by default | Built — private Circles, opt-in toggles, block/report, data export and reversible deletion |
| Accessible and inclusive | Built — 44px targets, focus rings, reduced motion, labelled icons |
| No dark patterns | Built — no unpaid-member ranking; the waitlist is neutral |
| Smallest complete vertical slice | Built — every shown control is wired |

## §2 Information architecture

- Five-destination bottom nav (Home, Circles, Create, Explore, You) — **Built**.
- Inbox as a top-bar icon with unread badge — **Built** (`screens/Inbox.tsx`,
  backed by `/v1/notifications`).
- Shared Money as a contextual area from a Circle and the profile — **Built**
  as the expense breakdown; the label is "Shared money", never "Wallet".
- Home feed sections: For You / Following — **Built** as filters. Nearby is
  not surfaced: it would need location permission, which the spec keeps out of
  this slice, so no control is shown rather than a dead one.
- Feed item types: text, poll, image — **Built**. Sponsored cards carry an
  advertiser identity, a "Sponsored" label and report controls — **Built**.
  Video/carousel, debate, quiz, event and shared-memory cards — **Deferred**
  (Phase 3/4); product/offer cards are surfaced through Explore's Shops and the
  storefront rather than as a feed card type.
- Explore tabs and filters — **Built** on a real discovery module
  (`modules/discovery.ts`): explainable ranking over places and discoverable
  plans, plus people search. Every ranked result carries its `reasons`.
- Media — **Built** as a local-disk stub (`modules/media.ts`): image upload with
  magic-byte validation, served from `/v1/media/<id>`, referenced by posts. A
  CDN/object-storage pipeline is **Deferred**.
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
  skeletons, a shared `EmptyState`, and inline retry; an explicit offline
  indicator is **Deferred**.
- Light and dark themes, remembered — **Built**.
- Subtle motion 120–220ms honouring reduced motion — **Built**.
- Icons: a consistent professional set (Lucide), not emoji. **Built**.
- Feed presentation: a flat editorial stream rather than a stack of uniform
  cards; cards are reserved for self-contained objects (profiles, Circles,
  plans, expenses). **Built**.

## §4 Core mechanics

- 4.1 Social graph: follow, block, mute, private profile audience — **Built**.
  Contact discovery is opt-in and never uploads an address book. **Built**.
- 4.2 Posts and feed: lifecycle (draft → published → edited with revision
  history), audience, server-side authorization, cursor pagination, reactions,
  comments — **Built**. Moderation states
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
  reversing audit events, private to Circle members — **Built**. The client can
  raise a dispute on an allocation (`disputed` state), and every change writes an
  audit event.
- 4.7 Commerce and orders: merchant/product catalogue, an order state machine,
  a provider-backed checkout, and a signature-verified webhook inbox with
  idempotency — **Built** (`modules/commerce.ts`, `modules/payments.ts`). An
  order is only marked paid by a verified provider webhook, never by a redirect.
  The **Bachs** adapter (`payments/provider.ts`) is a real integration; it needs
  credentials and provider/legal sign-off before it can run, and the stub
  remains for local use.
- 4.8 Advertising: the feed renders a labelled Sponsored placement with report
  controls — **Built**. Campaign creation, submission, and operator
  approve/reject review are **Built** (`modules/advertising.ts`); regulated
  categories are refused. Automated delivery of an approved campaign into the
  feed is **Deferred** (the spec's ad-exchange/RTB is out of V1); approval
  records eligibility, it does not itself place an ad.
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
- Bundle budgets for JS/CSS, enforced in CI (`scripts/check-bundle.mjs`,
  `.github/workflows/ci.yml`) — **Built**. A latency baseline harness
  (`scripts/loadtest.mjs`) measures p50/p75/p95/p99 for representative reads and
  writes and prints them for comparison over time — **Built**. The spec's
  numeric targets are **not claimed**: this host is not the target network or
  device class, and the spec says not to claim a target without measuring it in
  the right environment. Low-end Android/Nigerian-network measurement stays
  **Deferred**.

## §6 Architecture

Modular monolith with clear module boundaries, PostgreSQL source of truth,
Redis for ephemeral use, typed Fastify API — **Built**. Discovery and media are
new modules with the same boundary discipline. Search is implemented for people
(`/v1/search/users`), discovery (`/v1/explore`) and full-text post search
(`/v1/search/posts`, authorization applied in-query so a private post is not
returned) — **Built**. The production image serves the built client and the API
from one origin (`Dockerfile`), with migrations on boot; deploy and rollback are
`docs/deploy.md`. Queue, CDN/media pipeline, full observability stack
(tracing/metrics beyond structured request logs) — **Deferred**.

## §7 API contracts

Versioned `/v1`, consistent error envelope with request id, cursor pagination,
idempotency keys on non-repeatable writes, server-side validation, per-object
authorization, audit logs — **Built**. OpenAPI is published at
`GET /v1/openapi.json`, generated from the live route table so it cannot drift
from the code — **Built** (route/method/auth surface; request and response
bodies are enforced by zod at the boundary).

## §8 Trust, safety, compliance

Report from every surface, block/mute, moderation queue with actions and an
audit trail, no unpaid-member shaming — **Built**. Data export
(`GET /v1/me/export`) and account deletion with a 24-hour cooling-off window and
cancellation (`/v1/me/delete`, `/cancel`, `/execute`) — **Built**. Notification
preferences by type plus quiet hours, enforced server-side on fan-out —
**Built**. Advertiser verification is enforced: a campaign only runs for a
verified business, so an unverified advertiser cannot buy placement —
**Built**. A moderated account is blocked at authentication on every request,
not only on its next sign-in; a suspension is reversible and a ban ends live
sessions — **Built**. Age assurance, retention schedules beyond analytics, and
legal review of Nigerian data-protection duties — **Deferred** and flagged for
human review, as the spec requires professional advice.

## §9 Admin console

Reports queue with actions and an audit trail — **Built** (API + tests). The
staff console is **Built** for the surfaces the spec names: user lookup with
enforced account actions (warn/restrict/suspend/ban/restore), merchant
verification review, campaign approval/rejection, an overview of open queues,
and an audited log of staff actions (`apps/web/src/screens/Admin.tsx`,
`apps/api/src/modules/admin.ts`). It deliberately does not open private message
bodies; staff access to private content stays a separate, policy-governed path.
Appeals workflow — **Deferred**.

## §10 Analytics

Allow-listed event names, pseudonymous user references, allow-listed scalar
properties (a message body cannot be attached), server-side emission for real
actions, client ingest, and a retention prune — **Built**. Dashboards, funnels
and a warehouse export — **Deferred**.

## §11 Testing and acceptance

- Functional acceptance criteria: signup/privacy, authorized audiences, no
  duplicate feed items, Circle create/invite/leave, server-enforced voting,
  plan RSVP, exact expense splits, reported-never-verified-without-source,
  duplicate webhook safety, private-content authorization, audited moderation —
  **Built and covered by tests**.
- Performance, load, device and network testing — **Measured, not asserted**:
  `scripts/loadtest.mjs` produces a latency baseline on demand. The spec's
  numeric targets remain unclaimed here because this host is not the target
  environment. Bundle budget is enforced in CI as a proxy for payload size.
- Security: IDOR/BOLA, webhook forgery, replay and idempotency are covered by
  tests. Dependency and secret scanning run in CI on every push
  (`npm audit --audit-level=high` for production deps, and
  `scripts/secret-scan.mjs` over tracked files) — **Built**. Pen-testing of
  payment flows — **Deferred** and flagged for human review.
- CI runs typecheck, migrations, the test suite, the build and the bundle-budget
  gate on every push and pull request (`.github/workflows/ci.yml`) — **Built**.

## §12 Phased delivery

The spec lays out five phases. This is where each stands.

- **Phase 1 — social MVP.** Profiles, follow/block/mute, Circles, feed, polls,
  comments, reactions, realtime. **Built** and covered by tests.
- **Phase 2 — utility MVP.** Plans and RSVPs, shared expenses with exact splits
  and an auditable reported-vs-verified ledger, notifications, Explore
  discovery, media. **Built** and covered by tests.
- **Phase 3 — commerce and advertising.** Merchant/product catalogue, an order
  state machine, a provider-backed checkout and a signature-verified webhook
  inbox are **Built**; the **Bachs** adapter is a real integration (credentials
  and provider/legal sign-off required). Campaign creation, review and the
  labelled Sponsored placement are **Built**; campaigns require a business and
  delivery only serves a verified one. Still **Deferred**: automated ad
  exchange/RTB and any regulated-category advertising.
- **Phase 4 — IRL and events.** Events with a city/timezone, publishing, and a
  **server-validated check-in**: a code is issued by the organizer, can expire
  and can be revoked, and a person is checked in once (a retry is idempotent).
  A check-in shows a "verified" badge only when a provider actually backs the
  booking; otherwise the event says it has no verified booking. Event,
  video/carousel and memory post types exist in the shared domain vocabulary.
  **Built** at API + Web levels. Explicitly **not** built, per the spec's
  VERIFY boundaries: ticketing, reservations, payments, custody and location
  tracking — the event surface states plainly that an event is not a
  reservation or a ticket. Shared-memory capture UI and an event feed rail —
  **Deferred**.
- **Phase 5 — Vibe Pass and AI.** **Vibe Pass is Built**: a revocable pointer
  that resolves server-side, with holder-controlled sharing of display name,
  avatar and handle, and single-use-per-nonce loyalty redemption at a merchant.
  **AI assistance is Built**: `/v1/assist/propose` returns a labelled suggestion
  (draft plan, activity ideas, budget split, reminder) that a person accepts or
  dismisses; accepting records intent and creates nothing, so AI never sends,
  books, buys or moves money. The provider is a deterministic stub behind a
  `RemoteAssist` seam, so wiring a real model is a drop-in and is **Deferred**
  pending credentials. IRL perks and location-aware behaviour — **Deferred**
  (location is out of scope by design).

The first-sprint vertical slice is Phase 1 + Phase 2, working end to end.

## §13 Definition of done

A feature counts as done when the happy path works end-to-end, loading/empty/
error states exist, authorization is tested, accessibility is checked, and
tests cover transitions and duplicate events. This now holds across all five
phases: the full app is verified by an end-to-end walkthrough of every screen and
flow (`e2e.mjs`, 51 checks) plus the API suite (127 tests). Areas that still do
not meet the bar — offline indicators, dashboards, appeals — are listed above
rather than claimed.

## §4.2 content lifecycle — delete, undo, edit, replies

Implemented for both posts and comments:

- **Delete + undo.** Post and comment deletion are soft-deletes with a 30-second
  undo window. The client offers Undo in a toast; the server keeps the row and
  can restore it. A post's `deleted_by` distinguishes an author deletion from a
  moderator removal, and only an author's own deletion can be undone.
- **Comment replies.** One-level threading. A reply to a reply attaches to the
  same root, so the tree never nests arbitrarily. Replying notifies the parent
  author; a new top-level comment notifies the post author. Both honour the
  user's per-family notification opt-out.
- **Comment edit.** Edits record a revision (`comment_revisions`) before the
  live body changes, mirroring `post_revisions`, and the UI marks the comment
  edited.
- **Deleted-with-replies.** A deleted comment that still has visible replies is
  kept as a `[deleted]` placeholder so the replies are not orphaned.

## Payment provider status

The provider seam is `apps/api/src/payments/provider.ts` (`PaymentProvider`).
Two implementations exist:

- **Stub** — performs no network calls and never reports a successful charge. It
  exists for local development and tests only.
- **Bachs** — a real integration against the Bachs REST API
  (`POST /v1/checkout-sessions`, decimal money), with HMAC-SHA256 webhook
  verification over `"{timestamp}.{raw_body}"` and a 300 s replay window. It is
  selected with `PAYMENTS_PROVIDER=bachs` plus `BACHS_API_KEY`.

The adapter is built and unit-tested, but it is not claimed to be live: no Bachs
credentials are held here, and no live transaction has been run. The production
config guard refuses `PAYMENTS_PROVIDER=stub` under `NODE_ENV=production` and
refuses `bachs` without a key, so a production boot must have real credentials.
An order only reaches `paid` through a signature-verified webhook.

## Explicitly out of V1 (not built, by design)

Vibe-held wallet or stored value; pooled funds; P2P transfers; lending,
interest, crypto or investment; paid votes, betting or gambling; hardware;
full 3D metaverse; automated ad exchange/RTB; unreviewed regulated-category
advertising; AI taking payment or booking actions without confirmation.
