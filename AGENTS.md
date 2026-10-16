# AGENTS.md

Repository-specific guidance for AI agents working in this repo.

## What this is

Vibe — an interactive social network built to the VIBE product & engineering
specification. The first engineering sprint is implemented: a vertical slice of
Circles, polls, plans and shared expenses. Read
`docs/first-sprint-design-note.md` before changing behaviour; it is the source
of truth for schemas, state machines and permissions.

## Stack

- `apps/api` — Fastify 5 + PostgreSQL (`pg`), TypeScript ESM, run with `tsx`.
  Validation with `zod`. Tests with `vitest`.
- `apps/web` — React 18 + Vite, plain CSS with design tokens.
- `packages/shared` — money math and domain vocabulary, imported by both.

## Commands

```bash
npm install
npm run db:up        # Postgres + Redis containers
npm run migrate      # apply migrations
npm run dev:api      # API on :12000
npm run dev:web      # web on :12001
npm run test         # API tests (needs the database)
npm run typecheck
```

Docker in this environment needs `sudo`. Postgres/Redis containers are named
`vibe-pg` and `vibe-redis`.

## Conventions

- **Money.** Always integer minor units. Never floats. Use the helpers in
  `packages/shared/src/money.ts`; splits must sum to the total exactly.
- **Migrations.** Add a new file `apps/api/src/migrations/NNNN_name.sql`. Never
  edit an applied migration — the runner checksums them and will refuse.
- **Identifiers.** UUID. Timestamps `timestamptz` in UTC; store the IANA zone
  when a user-facing time needs it.
- **Errors.** Throw `ApiError` with a machine-readable code. The app's error
  handler renders the standard envelope.
- **Authorization.** Every object access re-checks membership on the server.
  Circle-scoped routes go through `modules/access.ts`. Never trust client
  filtering for private content.
- **Idempotency.** Non-repeatable writes (expenses, payment reports, checkout)
  require an `Idempotency-Key`.
- **Payments.** The provider is a stub. Do not add real provider calls or mark
  anything paid without a verified webhook. No custody, stored value, or P2P.

## Testing

Tests run against a real Postgres database (no mocks for the DB path). The
harness in `apps/api/tests/helpers.ts` truncates tables between tests. Add a
test for any state transition, retry, or duplicate-event path you touch.

## Web client

- `apps/web/src/nav.ts` holds a tiny in-memory navigation context: five tabs
  plus a stack of detail routes (inbox, profile, plan, expense, edit-profile,
  settings, place). It is not a router — swap it for one when deep links
  matter. Detail screens take an id.
- Icons come from `lucide-react`, re-exported through
  `components/Icons.tsx`. Never hand-roll SVG paths or use emoji.
- Empty states use `components/EmptyState.tsx` (icon + title + one line of
  help + an optional next action). Do not build one-off empty markup — the
  old `.empty` blocks rendered illegible text on the dark surfaces.
- The feed is a flat editorial stream (`.post`), not a stack of gradient
  cards. Cards are reserved for self-contained objects (profiles, Circles,
  plans, expenses).
- `realtime.ts` opens the `/v1/realtime` socket and only signals that something
  changed; every surface also loads over HTTP, so the UI stays correct when the
  socket is down.
- Avoid reloading a whole list after a small write (e.g. posting a comment);
  update local state, or the reload will remount cards and collapse open UI.


## Stacking and layering (learned the hard way)

- The decorative layers `.atmosphere` and `.grain` are `position: fixed` and
  must keep a **negative** z-index (-2 and -1). Page content (`.app-shell`,
  the auth hero, screens) is static, and static content paints *before*
  positioned siblings. If either layer gets a non-negative z-index it covers
  the whole page: every post, title and empty state renders at background
  brightness while only the sticky topbar and fixed bottom-nav (which set their
  own z-index) stay visible. That bug shipped once and made the app look empty.
- When adding any full-screen overlay, verify text is actually painted, not just
  that the element exists in the DOM. `getComputedStyle` reports the intended
  colour even when an overlay paints over it. Sample the rendered pixels.
- Minimum touch target is 44x44 CSS px. Icon-only buttons need an explicit
  `min-width`, and text links can use a transparent `::after` overlay to reach
  44px without changing the visible line height.

## Media, discovery, and location
- `modules/media.ts` is a local-disk stub: it accepts an image data URL,
  validates the decoded magic bytes, and serves the file from `/v1/media/<id>`.
  Swap `DiskMediaStore` for object storage later; keep the same boundary.
- Posts carry media in `posts.metadata.mediaUrls`. `createPostSchema` accepts an
  absolute `http(s)` URL or our own `/v1/media/<id>` path — nothing else, so a
  post can never smuggle in a `javascript:` URL.
- `modules/discovery.ts` ranks places and discoverable plans with an explainable
  score (area match, interest affinity, relationship, recency, verification).
  Every result returns `reasons`; never show a ranked item without them.
- **Location is a typed city + area label, never a device fix.** There is no
  `navigator.geolocation` call and no coordinate column anywhere. Do not add
  either. See `migrations/0002_discovery.sql`.

## Navigation
- `nav.ts` is an in-memory route plus a **stack** (`routeStack` in `App.tsx`).
  `push` grows the stack, `back` pops it. A detail view therefore returns to the
  screen it came from — a plan returns to its Circle, not straight to the tab.
- A tab tap must call `goToTabs()` (which clears the stack), **not** `back()`.
  Wiring the nav buttons to `back()` makes a tab tap pop one detail view, so
  tapping Explore from Settings lands on the previous screen instead.
- Circle detail is its own route (`{ name: "circle", circleId }`), not inline
  state in the Circles list, so it survives the plan/expense round trip.

## API serialization
- `publicUser(row)` reads `row.id` as the **user** id. When a row's `id` is some
  other entity (a post id, a conversation id), pass an explicit object:
  `publicUser({ id: row.author_id, handle, display_name, avatar_url })`. Passing
  the raw post row makes `author.id` the post id, which breaks every "is this
  mine" check (edit/delete affordances) and profile links. A regression test
  guards this (`tests/feed-author.test.ts`).
- Entity responses are **camelCase**; only raw analytics rows are snake_case.
  When a handler returns a DB row directly (e.g. a list), map it to camelCase —
  `priceMinor`, `amountMinor`, `unitAmountMinor`, `createdAt`. A screen that
  reads `price_minor` from a camelCase payload renders `NaN`, which no typecheck
  catches because the client types the response by hand. The e2e asserts on a
  formatted price and the absence of `NaN` for this reason.

## Analytics and notifications
- Analytics events are allow-listed by name and by property key
  (`modules/analytics.ts`). Unknown names are dropped; only scalar, allow-listed
  properties are stored. Never attach a message body or payment data.
- Server events are fire-and-forget (`trackSafe`), so a test that asserts on one
  must poll briefly rather than read immediately after the response.
- Notification opt-outs are keyed by a **family** ("plan_invite"), while emitted
  types are dotted ("plan.created"). `NOTIFICATION_FAMILY` in
  `modules/notifications.ts` is the single mapping. Add a mapping for any new
  type or the opt-out silently does nothing.

## Content lifecycle (posts and comments)
- Both posts and comments are **soft-deleted with an undo window**
  (`UNDO_WINDOW_MS`, 30 s, in `modules/feed.ts`). The server keeps the row and
  the client offers Undo; the two windows must stay equal.
- Posts record `deleted_by`. Undo is only allowed when `deleted_by` is the
  author, so an author can never restore content a moderator removed. Keep that
  distinction when touching the delete/restore routes.
- A deleted comment with visible replies is kept as a `[deleted]` placeholder so
  the replies are not orphaned; a deleted comment with no replies is dropped
  from the thread. Replies are capped at one level: a reply to a reply attaches
  to the same root (`parent_id`), so the tree never nests arbitrarily.
- Edits are auditable, not silent: `post_revisions` and `comment_revisions`
  record `previous_body`/`new_body` before the live body changes.

## Feed ranking and the per-author cap
- `diversify()` keeps at most **three posts per author per page**. A probe or
  test that creates several posts as one user and then looks for the newest one
  in the feed will fail. Create the post as a **fresh account** instead. This
  bit both the comment probe and the first e2e run.

## Commerce, payments and advertising
- Order lifecycle lives in `modules/commerce.ts` (`ORDER_TRANSITIONS` +
  `transitionOrder`). A transition is allowed **only** if it is listed; a
  same-status target is a no-op. `paid` is reachable directly from `created`
  because a provider webhook can arrive before our own checkout status write
  lands, and the provider is authoritative about whether money moved.
- An order reaches `paid` **only** from a signature-verified webhook
  (`applyProviderEvent`), never from the checkout redirect. Webhook events are
  deduped by `(provider, event_id)`; a redelivery is a no-op.
- The provider seam is `payments/provider.ts`. `bachs` is a real REST adapter;
  `stub` is local-only and refused in production. Bachs webhook signature is
  HMAC-SHA256 of `"{timestamp}.{raw_body}"` over the **exact raw bytes**, so the
  JSON content-type parser in `app.ts` captures `req.rawBody`. That parser must
  treat an empty body as `{}` — a POST with no payload (e.g. `/checkout`)
  otherwise throws `Unexpected end of JSON input` and 500s.
- Bachs sends the event id as `id`; the normalised parser falls back to `id` when
  `eventId` is absent, or every event collapses to `"unknown"` and dedupes
  against itself.
- Merchants start `unverified` and cannot publish an active product until
  verified. Verification and campaign review are operator actions
  (`requireAdmin`); the e2e run grants the actor admin directly, as an operator
  would be provisioned.
- Campaigns: draft → submitted → operator review → approved/rejected. Only an
  approved campaign for a **verified** business is eligible to run. Delivery is
  built (`modules/ads.ts` `selectAdForViewer`, wired into `buildFeedPage` in
  `feed.ts`): the sponsored slot is appended after the first organic item, never
  sorted into ranking, and is frequency-capped and hideable. Metrics are
  reported and verified **separately** — never summed into one number.
  Regulated categories are refused at creation.

## Phases 3–5 modules (events, pass, AI, push, search, admin)
- Events and check-in live in `modules/events.ts`. A check-in code is issued by
  the organizer, can expire and can be revoked, and is hashed (`sha256Hex`) at
  rest. Check-in is idempotent: a retry returns `alreadyCheckedIn: true` and does
  not create a second row. A booking is reported `verified` only when a provider
  reference backs it — never inferred.
- Vibe Pass (`modules/pass.ts`) is a revocable pointer. The token carries no
  personal data; `resolve` returns only the fields the holder has consented to
  share. Loyalty redemption is single-use per `(merchantId, nonce)` — a replay
  returns `duplicate: true` and does not redeem again.
- AI (`modules/ai.ts` + `ai/provider.ts`) only ever proposes. `accept` records
  intent and creates nothing. The provider is a deterministic stub behind the
  `RemoteAssist` seam; wiring a real model is a drop-in. Do not let an assist
  path take a consequential action (send, book, buy, move money) without a human
  confirmation step.
- Push (`modules/push.ts`) stores device tokens and hints only the last 6 chars
  in responses — never echo a raw token. Delivery is a no-op stub
  (`deliveryProvider: "stub"`) until a real sender is configured.
- Search (`modules/search.ts`) applies authorization **in the query**, not after
  it, so an unauthorized row is never fetched. Keep it that way.
- Admin (`modules/admin.ts`) enforces account actions at auth time: a moderated
  account is blocked on every request by `requireUser`, not only at next login.
  A suspension is reversible (sessions stay live, gated by `requireUser`); a ban
  revokes live sessions. Every staff action writes an `audit_events` row.
- Account moderation status lives on `users.moderation_status`
  (`migration 0009`); `resolveSession`/`AuthUser` carry it.

## Verification tooling
- `scripts/loadtest.mjs [baseUrl] [iterations]` prints p50/p75/p95/p99 for
  representative reads. It deliberately does **not** assert the spec's latency
  targets — this host is not the target environment. Compare runs over time.
- `scripts/secret-scan.mjs` scans tracked files (not `node_modules`/build) for
  secret shapes. Narrow patterns on purpose; keep it low-noise.
- CI runs both, plus `npm audit --audit-level=high --omit=dev`, on every push.
  If `npm audit` flags a dependency, fix it rather than downgrading the gate:
  `@fastify/static` was pinned `^10.x` because `8.x` had path-traversal and
  route-guard-bypass advisories, and that module serves the web client.
- `GET /v1/openapi.json` is generated from the live route table (`onRoute` hook
  in `app.ts`), so it cannot drift. Fastify `:id` params are rewritten to
  OpenAPI `{id}`. It documents routes/methods/auth; bodies stay in zod.

## Build and CI gotchas
- The CI `verify` job sets `NODE_ENV=test` for the API suite. That env leaks
  into every later step, including the Vite build. Vite picks the dev React
  build under any `NODE_ENV` other than `production`, which roughly doubles the
  JS bundle (144 kB vs 81 kB gzip) and fails the budget check. The build step
  sets `NODE_ENV=production` explicitly. A local `npm run verify` passes either
  way because `NODE_ENV` is usually unset locally — so always confirm a budget
  change against the CI build, not just local.
- `vite build --mode production` does **not** fix this; the `NODE_ENV`
  environment variable wins over `--mode` for the React dev/prod define.

## Web client gotchas
- Comment activity updates the count via a local delta
  (`onCommentChange`), **not** `onChanged()`. `onChanged()` bumps the global
  `refreshKey`, which reloads the feed and remounts the card, collapsing the
  thread the user is posting in.
- Transient confirmations with an optional action use `components/Toast.tsx`
  (`.toast-host`, z-index 70). Undo toasts pause their timer on hover/focus.
- React-controlled inputs cannot be driven in a CDP probe by setting `.value`
  directly. Use the native setter
  (`Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set`).

## Immersive activities addendum (rooms, location, launch seeding)

- Migration `0010_activities_live.sql`; modules `activities-live.ts`,
  `location.ts`, `launch.ts`. Web screen `screens/Live.tsx`.
- **Live state is derived, never stored.** `effectiveRoomState` is the only
  place that decides live / starting soon / scheduled / ended; `state_override`
  holds only a terminal `ended`/`cancelled`. Do not add a boolean `is_live`.
- **Coordinates are rounded before storage.** `roundBand` (~1.1 km) is the only
  writer of `users.lat_band/lng_band`. Never store or return a precise point;
  never return any point to another member. Explore falls back to city/area.
- **Hosts are always labelled.** `users.host_kind` has no "undisclosed" value
  and `publicUser` always exposes it. Official hosts cannot be signed into by a
  human (password is `!disabled`) and cannot post as a personal account.
- **Vibe coordinates, it does not retransmit.** A `synchronized` room must link
  a licensed service (`assertRoomHonest`); `playback_mode` states which it is.
- **No stakes anywhere.** Room polls are fan polls; there is no wager field.
  Do not add one.
- **Covert population is refused.** Do not build undisclosed accounts that
  imitate people, and do not remove the label. `scripts/synthetic-traffic.mjs`
  is staging-only and refuses a production target. Full reasoning lives in
  `docs/spec-coverage.md` under "Why covert accounts were not built".

## Do not

- Introduce floating-point money arithmetic.
- Mark a payment, purchase or check-in complete without server confirmation.
- Add dead-end UI: if a button is shown, it must work.
- Break existing API contracts without a migration plan.
- Build payment-provider, custody, location or regulated-advertising behaviour
  without the boundary being explicitly approved. The provider seam is
  `payments/provider.ts` (`PaymentProvider`); the **Bachs** adapter is a real
  implementation of that interface, with webhook signature verification and
  idempotency. It must not be described as live or working without credentials,
  and it never reports success on its own: only a verified webhook marks an
  order paid. Custody/stored-value and regulated-category advertising stay out.
  A provider name alone is not an approval; do not weaken the production config
  guard (`SESSION_SECRET`, `PAYMENTS_PROVIDER`) on the strength of one.
