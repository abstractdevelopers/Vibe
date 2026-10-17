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
  built (`modules/ads.ts` `selectAdForViewer`, wired into `feed.ts`): the
  sponsored slot is a separate response field (`sponsored`) the client renders
  after the **15th** organic post (`SPONSORED_AFTER` in `modules/feed.ts`, and
  the same constant on the client). It is never sorted into ranking, and is
  frequency-capped and hideable. Delivery is only chosen when the page actually
  has more than `SPONSORED_AFTER` items, so an impression is never counted for
  an ad the viewer could not see. A test that wants a delivered ad must seed a
  page longer than 15 posts across **several authors** — the feed caps each
  author at three posts per page, so one account cannot fill it. Seed those
  authors with a direct `INSERT INTO users` (the sign-up route is rate limited).
  Metrics are reported and verified **separately** — never summed into one
  number. Regulated categories are refused at creation.

## Vibe Yens (stored balance) — gated
- `WALLET_ENABLED` (default **false**) gates the whole surface. When off,
  `walletRoutes` registers nothing, so every wallet route 404s — there is no
  dead money-moving endpoint reachable. Do not weaken this default: a stored
  balance and P2P transfer are stored value and money transmission, and V1
  forbids them unless an operator has cleared it.
- The money model is unchanged: a balance is a SUM over double-entry journals
  (`walletBalance` in `money/ledger.ts`), never a mutable column. A top-up
  credits the wallet **only** from a signature-verified webhook
  (`settleWalletTopup`), keyed on the `WALLET-` reference prefix. A send moves a
  liability between two wallets inside one transaction that re-checks the
  balance, so two concurrent sends cannot overdraw.
- Adding any new notification type needs a `NOTIFICATION_FAMILY` entry
  (`wallet.received → wallet`) **and** a `NOTIFICATION_TYPES` entry in
  `modules/account.ts`, or the opt-out silently does nothing. A new analytics
  name must be added to `ANALYTICS_EVENTS` or `trackSafe` drops it.

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
- **Cold screens are code-split.** `App.tsx` lazy-loads the menu/detail screens
  most sessions never open (`Wallet`, `VibeYens`, `Pass`, `Admin`, `Assist`,
  `Advertising`) behind a `Suspense` boundary. Keep it that way: the launch
  bundle sits at ~92% of its raw budget, so adding a screen eagerly (or a heavy
  import) will fail `check-bundle` in CI. Add new rarely-opened screens as
  `lazy(() => import(...))` rather than raising the budget.
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

## Auth, email and rate limits

- Migration `0011_auth_hardening.sql`. Modules `modules/mailer.ts`,
  `modules/ratelimit.ts`.
- **Email goes through the outbox.** Never call a mailer directly from a route.
  Write to `email_outbox` inside the same transaction that needs it
  (`queueEmail`), and let the drain timer send it.
- **Reset responses must not differ by whether the email exists.** Keep
  `/v1/auth/forgot` identical in every case.
- **Store token hashes, never tokens.** Same rule as sessions.
- **Rate-limit new auth routes.** Bucket by IP *and* the identity being tried,
  and clear the bucket on success. `ApiError.tooManyRequests` is the 429.
- **The rate-limit store is a table, not Redis.** It is correct for one
  instance only. If a second instance is ever added, move it to Redis behind
  the same interface before scaling.
- Production refuses to boot without `EMAIL_API_KEY` and with `CORS_ORIGIN=*`.
  Do not weaken those guards.

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

## Deployment (Coolify, single server)

- **`COPY . .` in the Dockerfile runtime stage is load-bearing.** A multi-source
  `COPY apps packages scripts ./` copies directory *contents*, so `/app/apps/api`
  disappears, migration dies with `ERR_MODULE_NOT_FOUND`, and the workspace
  symlinks under `node_modules/@vibe/` dangle.
- **The runtime image needs `curl`.** Coolify's rolling deploy probes the
  container with curl; `node:22-slim` has none, so deploys get marked unhealthy
  and rolled back even though the app booted fine. The in-image `HEALTHCHECK`
  uses `node`'s fetch and was never the issue.
- **Docker publishes ports past ufw.** ufw only filters `INPUT`; published
  container ports traverse `FORWARD` via DNAT. Restrict them in `DOCKER-USER`
  and match the **pre-DNAT** port with `-m conntrack --ctorigdstport`
  (`--dport` sees the rewritten port, so `--dport 8000` misses and
  `--dport 8080` would also expose Traefik's dashboard). Persist with a
  systemd unit. Without this, the Coolify panel and the Traefik dashboard are
  on the public internet.
- **Coolify API:** the app domain is set through `domains` (a string); `fqdn`
  is read-only and rejects writes. `POST /api/v1/deploy?uuid=<app>` triggers a
  deploy and returns a `deployment_uuid` to poll.
- **Test the image locally before pushing.** Build it, boot it against a
  throwaway Postgres, and check `/health` plus `/` — that is what caught both
  Dockerfile bugs.
- **`npm test` from the repo root, not `npx vitest`.** The single-fork setting
  lives in `apps/api/vitest.config.ts`; running vitest from the root skips it
  and the integration tests stampede the shared database.
- **Losing the deploy key is survivable, but only through Coolify.** Coolify
  reaches its own host over the Docker socket, not SSH, so it keeps working when
  SSH is locked down. To get back in: generate a keypair, then
  `POST /api/v1/applications/<uuid>/storages` with
  `{"type":"file","mount_path":"/app/.vibe-host-authorized-keys",
  "fs_path":"/root/.ssh/authorized_keys","content":"<pubkey>\n"}`, deploy,
  then delete the storage and redeploy. The `pre_deployment_command` hook does
  **not** help: it runs inside the app container (`docker exec … sh -c`), so it
  cannot reach the host.
- **A file mount to `/root/.ssh/authorized_keys` overwrites, it does not
  append.** There is one entry unless you write the whole file. It also lands
  with odd permissions (711), so fix it to 600 and make sure it ends in a
  newline.

- **Coolify deploys to its own host over SSH, so `authorized_keys` is
  load-bearing.** Coolify's key lives at
  `/var/www/html/storage/app/ssh/keys/ssh_key@<id>` inside the `coolify`
  container (derive the public half with `ssh-keygen -y -f <key>`). Removing it
  from `/root/.ssh/authorized_keys` breaks every deploy with
  `Permission denied (publickey)`, including a redeploy that would otherwise fix
  things — you cannot deploy your way out. Keep it in the file.
- **Coolify env vars default to `is_buildtime: true`.** The bulk env endpoint
  treats an omitted field as build-time, so a deploy then passes every secret to
  the Docker build as an `ARG` and BuildKit refuses:
  `SecretsUsedInArgOrEnv`. Set `is_buildtime: false` for runtime-only values.
  The field is `is_buildtime` on write, `is_buildtime` on read — there is no
  `is_build_time`.
- **The Coolify API token is not on this machine; recover it from history.**
  It was written to `/tmp/.coolifyapitoken` in an earlier session, and `/tmp` is
  wiped between sessions. It is still in this conversation's event log under
  `/workspace/conversations/<id>/events/`, so
  `grep -rl coolifyapitoken` then reading the writing command recovers it. The
  API base is `http://172.104.128.165:8000/api/v1`. Prefer storing it somewhere
  that survives, or re-mint it in the Coolify panel.
- **`users.is_admin` has no writer in the product.** Nothing sets it: no route,
  no migration, no seed. A fresh deploy therefore has *zero* operators and the
  operator console (merchant verification, campaign review, report handling,
  launch seeding) is unreachable. Use
  `npm --workspace @vibe/api run operator -- --grant <email>` (a CLI on purpose,
  not an endpoint).
- **Nothing charges an ad budget.** `campaigns.budget_minor` is stored and
  reported, but no code debits it — there is no spend ledger and no
  authorization at review time. A campaign can run indefinitely at no cost. The
  order path is different and real: it goes through Bachs.
- **Ad creatives were text-only; a banner image is now supported.**
  `campaigns.creative_image_url` (migration 0013) holds an absolute http(s) URL
  or a `/v1/media/<id>` path, the same contract as `users.avatar_url`, so the
  existing upload path is reused rather than a new one trusted. The feed renders
  it as `.ad-banner` and the whole image is the tap target. It is nullable, so a
  text-only campaign still renders.

## Money

The gift feature grew from a free gesture into paid gifts, a creator balance,
bank accounts and payouts. What is worth knowing:

- **The ledger is double-entry and a balance is a SUM, never a column.**
  `apps/api/src/money/ledger.ts` writes journals whose entries must sum to zero;
  a deferred constraint trigger (`ledger_entries_balanced`) enforces it at
  COMMIT. `creatorBalance()` derives everything from `ledger_entries`. Do not add
  a `balance` column: it is the one change that would let a bug silently create
  or destroy money.
- **A purchase is not a payment.** `gift_purchases` starts `pending`. Only a
  signature-verified webhook (`settleGiftPurchase`) marks it `paid` *and* writes
  the journal, in one transaction. The reference prefix is the dispatch key:
  `GIFT-` for gifts, `WD-` for payouts.
- **Idempotency is a constraint, not a code path.** `paid_gifts.purchase_id` is
  UNIQUE, so a redelivered webhook cannot double-deliver; the webhook inbox
  primary key `(provider, event_id)` already dedupes. Rely on both.
- **A refund reverses; it never edits.** Post the mirror journal. Getting this
  wrong is easy and the test catches it: the first version posted to a separate
  `gift_refunds` account *and* credited cash, which does not balance. A refund is
  simply the purchase journal with every direction flipped.
- **Bachs does payouts, and it is confirmed live.** `GET /v1/payouts` returns a
  completed payout, and `POST /v1/payouts/destinations` registers a bank account
  (NUBAN, 10 digits, plus a bank code) that must reach `approved` before it can
  be paid. A payout takes `destination` (a `pd_...` id) plus `amount` and
  `currency`. See `apps/api/src/payments/payouts.ts`.
- **Payouts are OFF by default.** `PAYOUTS_PROVIDER` defaults to `disabled` and
  the disabled provider throws on every call, so a deployment whose payout flow
  has not been reviewed cannot pay anyone. Set it to `bachs` deliberately.
- **Vibe does not store full account numbers.** Only the provider's opaque
  destination id and the last four digits are kept, for display.
- **The fee split is per-gift data, not a constant.** `gift_catalogue.fee_bps`
  is stored on the purchase, so the split is reproducible after the fee changes.
  Vibe keeps 30%; the creator earns 70%, held 7 days, minimum payout N1,000.
- **`MEDIA_DIR` must point at a mounted volume or uploads die on deploy.** The
  disk media store wrote to the container layer, so every redeploy wiped every
  uploaded image and avatar, which looks exactly like "upload is broken". A
  Coolify persistent storage (`type: persistent`, mount `/app/media`) plus
  `MEDIA_DIR=/app/media` fixes it. Check this first when a media bug is reported.

## Licensing, read before switching payouts on

Holding a user's balance and paying it out to a bank account is a regulated
activity (in Nigeria, a CBN licence covers disbursing other people's money at
scale). The engineering is complete and tested; the legal basis is not
established by code. Do not set `PAYOUTS_PROVIDER=bachs` in production until
that is confirmed with Bachs and a lawyer.

## Verification and environment gotchas

- **The sign-up limiter is 10 per IP per hour.** `register:` is keyed on the
  client IP, so a burst of test accounts returns 429, not a bug. The counter
  lives in `rate_limit_counters`; `DELETE FROM rate_limit_counters` resets it.
  `scripts/e2e_launch_test.py` does this automatically against localhost.
- **A malformed `:id` is a 404, not a 500.** Routes pass `:id` straight to
  Postgres, so a non-UUID raises SQLSTATE `22P02`. The central error handler in
  `apps/api/src/app.ts` maps that to `not_found`. Add new error mappings there,
  not at each call site.
- **`NODE_ENV=development` in your shell poisons the web build.** Vite inlines
  React's development build, which roughly doubles the bundle (370kB to 830kB)
  and blows the budget. Run `env -u NODE_ENV npm run build` if you have been
  running the API in dev mode in the same shell.
- **Posts default to the `connections` audience.** A new post is visible to its
  author but not to a stranger's For You feed. Use `audience: "public"` when a
  test needs a post to be widely visible.
- **The Coolify API token is not on this machine.** It was written to
  `/tmp/.coolifyapitoken`, and `/tmp` is wiped between sessions. Recover it from
  this conversation's event log under `/workspace/conversations/<id>/events/`
  (`grep -rl coolifyapitoken`), then rewrite the file before deploying.
- **Docker is not always running.** If Postgres refuses connections
  (`ECONNREFUSED 127.0.0.1:5432`), start the daemon (`sudo dockerd &`, then
  `sudo chmod 666 /var/run/docker.sock`) and `docker compose up -d postgres`,
  then re-run migrations.
- **A payout only completes on a provider webhook.** Payouts are requested with a
  `WD-` reference on the same `/v1/webhooks/payments` endpoint as collections.
  The handler must subscribe to `payout.paid` (and `payout.failed` /
  `payout.reversed`); before this was wired, `settlePayout` in
  `apps/api/src/money/settlement.ts` was dead code and a payout sat at
  `processing` forever. If you add a provider, keep the reference prefixes
  (`GIFT-`, `WD-`) and the event-type mapping in `payments/provider.ts` aligned.
- **Payouts are enabled per environment.** `PAYOUTS_PROVIDER=bachs` on the
  Coolify app turns the creator-withdrawal path on; unset, every payout route
  returns 503 by design. Bachs already has approved NGN destinations on the live
  account, so the switch is the only gate.
- **The mobile layout is width-driven.** There are breakpoints at 720/480/360px
  in `apps/web/src/styles.css`. Before adding a fixed width or a `min-width`,
  check it against 360px; the phone is the primary surface. `overflow-x: hidden`
  on the body hides overflow rather than fixing it.
- **Two gift sheets exist.** `GiftSheet` is the free, non-monetary cheer;
  `PaidGiftSheet` is the real-money picker (Bachs checkout, 70/30 split). The
  post's gift button opens the paid picker on someone else's post and the free
  sheet on your own. Do not put price copy in the free sheet.
- **Bachs is the live payment provider, and its API is documented.** The adapter
  in `apps/api/src/payments/provider.ts` follows `docs.bachs.io`: the checkout
  body is `pricing: { currency, amount }` (a decimal string, no `type`, no
  per-request `webhook_url`), the collection webhook nests fields under `data`
  (`checkout_id`, `reference`, `status`, `amount`, `currency`), and a payout
  webhook carries `withdrawal_id`. Verification must accept
  `X-Bachs-Signature-V2` (`t=...,v1=...`, any `v1` may match during a rotation)
  as well as the bare `X-Bachs-Signature` with `X-Bachs-Timestamp`. `success_url`
  must be a public https URL — Bachs refuses localhost, so a local checkout
  cannot be walked end to end without a tunnel.
- **A ticket is a purchase, not a balance.** A paid live room reuses
  `gift_purchases` (with a `room_id`) and the `TKT-` reference so it inherits the
  whole verified-webhook and ledger path; `settleTicketPurchase` grants
  `room_tickets` on the webhook. Never grant entry from the request. Journal
  kinds are `ticket_purchase` / `ticket_refund`; `splitGift` gives the 70/30 cut.
- **Invite links are handled in the client, not by a router.** The app routes in
  memory (`nav.ts`), so `App.tsx` reads `/invite/<token>` (or `?invite=`) at
  boot, strips it from the address bar, and either shows `InviteLanding` above
  sign-in or auto-accepts once `me` loads. `GET /v1/invites/:token` is public
  and previews the Circle's name only — never members or posts.
- **`Live` is reached from the Explore card.** The `live` route has no tab of its
  own; if you move that entry point, the whole voice/ticketed-room surface
  becomes unreachable.
- **A Circle delete is a soft delete.** `DELETE /v1/circles/:id` sets
  `archived_at` (owner only); every list and the detail route filter on
  `archived_at IS NULL`. Editing is admin-level (`PATCH /v1/circles/:id`). Do not
  turn this into a hard delete: plans, expenses and chat history belong to the
  members, not the owner.
- **Seller fulfilment lives at `POST /v1/orders/:id/transition`.** The seller
  drives `seller_confirmed → fulfilling → completed`; the buyer may cancel an
  unpaid order or raise a dispute. `refunded` is deliberately not an accepted
  target — only a verified provider webhook marks money returned, so a seller
  can at most set `refund_pending`. The seller's inbox is `GET /v1/seller/orders`
  (optionally `?open=true`), surfaced as Sales in Settings.
- **Every top-level screen uses `ScreenHeader`** (`eyebrow` / `title` /
  `subtitle` / `action`) so a screen never opens as a bare word. The Home
  greeting is time-aware and the line under it rotates daily — both are pure
  presentation and carry no state.

## End-to-end testing against a live deploy

Two harnesses drive the deployed API over HTTP (no mocks). They live outside the
repo, in the sandbox's persistent tools dir: `/workspace/.tools/e2e.py` (whole
product surface) and `/workspace/.tools/payments_e2e.py` (the money path).
`/root/payhook.sh` on the server signs a Bachs webhook with the real
`BACHS_WEBHOOK_SECRET` so the payment → fulfilment chain is exercised for real.

Gotchas the harnesses encode, in case you write new checks:

- **`is_admin` has no writer in the product.** The operator console is only
  reachable after `UPDATE users SET is_admin = true ...` out of band.
- **A private Circle needs an accepted invite.** `POST /v1/circles/:id/invites`
  returns a one-time `inviteToken`; the member joins via
  `POST /v1/invites/:token/accept`. `POST /v1/plans` and `GET /v1/plans/:id`
  are member-gated, so a non-member gets 403.
- **Money routes require an `Idempotency-Key` header**: orders, checkout, gift
  purchase, expenses. Omitting it is a 400, not a 500.
- **`PAYMENTS_PROVIDER=bachs` points at `sandbox-api.bachs.io`.** Checkout
  returns 202 and only creates a provider session; the order stays
  `awaiting_payment` and fulfilment is refused until a signed webhook arrives.
  `refunded` is not even an accepted `transition` target (422) — only a webhook
  moves money back.
- **Register/login are rate-limited per IP** (10/hour, 8/15min). Repeated runs
  hit it; clear `DELETE FROM rate_limit_counters WHERE bucket LIKE 'register%'`
  between runs rather than assuming a bug.
- **`sshd` is `ssh.service` on Ubuntu**; `systemctl is-active sshd` is
  misleadingly "inactive" even while SSH is up.
- **Sheets are `.sheet-card` / `.sheet-head`, and both must be styled.** The
  create and "start something" sheets sit on a full-screen scrim; without a
  background on `.sheet-card` the scrim shows through and the sheet's contents
  float as transparent, overlapping text over the page ("bleeding"). Both
  classes mirror `.sheet-inner` (gradient background, padding, top radius).
  A transparent `backgroundColor` is expected — the fill is the
  `background-image` gradient, so check `backgroundImage`, not `backgroundColor`,
  when verifying a sheet in a browser.
- **The account menu is capped above the bottom nav on short screens.** On a
  320×568 phone the menu's max height keeps it clear of the nav (menu bottom
  ~452, nav top ~499) and it scrolls internally, so "Log out" is reachable
  rather than covered. On tall phones it is uncapped (menu bottom ~677).
- **A cheer is stored in `post_gifts`, not `reactions`.** Free cheers and paid
  gifts share the table; `feed.ts` returns `giftCount` and `viewerCheered` from
  subqueries so a post shows its cheer count and a sender sees their own. The
  cheer uses `CheerIcon` (PartyPopper), not the decorative `SparklesIcon`.
- **Event artwork is `events.image_url`** (migration 0018), same contract as
  `campaigns.creative_image_url`: an absolute http(s) URL or `/v1/media/<id>`.
  Rendered by the `.event-banner` class (16:9, `object-fit: cover`). A bad URL
  is a 422 from the zod regex.
- **Live rooms are built on `activity_rooms` / `room_members`.** `kind` includes
  `voice` (open stage) and `listen` (listening party); `room_members.role`
  includes `speaker` with `hand_raised` / `muted_by_host`, and a room carries
  `audio_track` / `audio_started_at` for synced listening. The Live screen
  already has the "Watch party" / "Match room" create kinds and a
  `playbackMode` (YouTube) path — but the room *view* has **no gift button and
  no stage/audience UI yet**, and there is **no room-scoped gift route** (gifts
  are post-scoped only). Those are the concrete gaps for items 5–7.
- **Hard-deleting a user is blocked by RESTRICT FKs.** `users` has ~71 FKs;
  `gift_purchases`, `expenses` (payer), `circles` (creator), `ledger_accounts`,
  `payouts` and `paid_gifts` use RESTRICT, so a bare `DELETE FROM users` fails.
  The product itself only *soft*-deletes (sets `deleted_at`, keeps financial
  records). To purge synthetic accounts: delete `gift_purchases`, `expenses`
  (payer or creator), and `circles` (creator) for those users first, then
  `DELETE FROM users` — everything else cascades. Match `%@example.com` /
  `%@vibe.test` and exclude `host_kind = 'official'`.
- **Seeded official content uses a `vibe` host account** (`host_kind =
  'official'`, disclosure set) that publishes events through the normal API.
  Event banners are generated locally (Pillow) and uploaded via `POST
  /v1/media`, so they are self-hosted under `/v1/media/<id>` — no hotlinking.
  The media volume is mounted at `/app/media` with `MEDIA_DIR=/app/media`, so
  uploads survive redeploys.



## Launch state (verified against the live deployment)

- **Wallet is ON in production.** `WALLET_ENABLED=true` is set on the Coolify
  app. The operator confirmed they are under Bachs compliance, so the V1
  "no stored value" default is overridden deliberately here.
- **Migrations are current.** `0019_live_experience.sql` and `0020_wallet.sql`
  were applied by the app boot migration runner on redeploy; check with
  `SELECT name FROM schema_migrations ORDER BY name`.
- **Payout provider errors are typed.** `payments/payouts.ts` throws a
  `ProviderError` carrying the provider HTTP status. The money routes map a
  4xx (e.g. Bachs BANK_ACCOUNT_NOT_VERIFIED) to a 400 with the provider
  message and a 5xx to `provider_unavailable`; before this a refused bank
  account surfaced as a generic 500. Regression: `tests/payout-errors.test.ts`.
- **Money settlement is proven through the ledger.** `tests/money-flow.test.ts`
  drives each paid path (gift, live ticket, wallet top-up, wallet send, order)
  end to end and asserts on `ledger_journals` / `ledger_entries`. A paid gift
  and a ticket each book 70/30; a top-up credits only after a verified webhook;
  an order transitions with no journal (orders are not on the ledger yet).
- **The webhook response includes the wallet settlement result.** It was
  computed but omitted from the JSON reply.
- **A real checkout probe.** `scripts/live_checkout_probe.py` registers two
  users, buys a paid gift against the live deployment, and prints the Bachs
  hosted checkout URL. Nothing is charged until a human pays; the purchase
  stays pending and no journal is written.
- **Coolify deploys are manual.** There is no GitHub webhook, so a push does
  not deploy. Trigger one with POST /api/v1/deploy?uuid=<app-uuid>.
- **Games are server-authoritative and stake through the ledger.** A game
  session stores its full engine state; every move is validated against that
  state, persisted with a sequence, and only then broadcast, so a client cannot
  invent a win or replay a move. `game_catalog` lists every title with an
  `availability` of `playable` or `planned`; only `whot` has an engine and the
  create route refuses a game that has none, so the "coming soon" badge is
  enforced, not decorative. Stakes move real wallet Yens into a per-session
  escrow account and pay the winner with a 5% rake to revenue, as ordinary
  journals, so a game can never create or destroy Yens.
- **A game's host is seated and staked at creation.** The host does not go
  through `/join` — they are already in the room — so the create route stakes
  them and writes their `game_players` row inside the same transaction. Missing
  this leaves a host with no stake who can still win the pot.
- **`eventView` must forward `host_kind`/`host_disclosure` to `publicUser`.**
  `publicUser` defaults an absent `host_kind` to `"person"`, so any query that
  feeds it must `SELECT u.host_kind, u.host_disclosure` too. An event run by the
  official Vibe account otherwise looks like it was organized by a person,
  defeating the host label.
- **Published events are public.** `GET /v1/events` and `GET /v1/events/:id`
  use `authenticate` (optional), not `requireUser`, so a published event is
  readable with no session; drafts and cancelled events stay visible only to
  their organizer or an operator. Explore already served published events
  without auth; keep the two surfaces consistent.
- **Every game implements one engine contract.** `apps/api/src/games/engine.ts`
  defines create/apply/view/turnUserId/finished/winnerId/autoMove; the routes in
  `modules/games.ts` never look at rules. Adding a game is: implement the
  interface, register it in `games/registry.ts`, and mark the catalogue row
  `playable` with its `engine` id. `tests/game-engines.test.ts` drives every
  registered engine to a finish through its own `autoMove` — if that test fails,
  the game is not safe to stake.
- **A staked game must always settle.** War and Simon cap their rounds so a game
  cannot run forever; a draw refunds every stake (`settleGame` with `refund`),
  and a refund zeroes `pot_minor` so it cannot pay twice. Randomness that decides
  money (dice, spins, crash points) is drawn from a seed in the state, never from
  the client — Snakes rolls server-side for exactly this reason.
- **Party games are picks or guesses from a fixed set, not free text.** A server
  can only settle a game it can judge, and settlement is what staking depends on.
- **Themes are authored, not random.** `apps/web/src/themes.ts` holds 34 base
  palettes × 4 styles = 136 themes; each computes its accent ink by luminance so
  text stays legible. The atmosphere glows read `--theme-glow-a/--theme-glow-b`,
  which `applyTheme` sets alongside `--accent`. "Follow activity" (Settings) tints
  the app to the current game via `useActivityTheme`; a manual pick always wins.
- **Live/voice rooms are a WebRTC mesh.** The server relays SDP/ICE over the
  realtime socket and never carries media; `MESH_SPEAKER_LIMIT` is 8 speakers
  before an SFU is needed. Room kinds (voice/listen/movie/sports/music/other)
  share one transport; each has its own panel in `RoomKindPanels.tsx` — a match
  room shows a scoreboard, a listen/music room shows a queue, a watch party
  shows its licensed-service link. Read routes for live/rooms require a session.
- **A room has a format: `stage` (open mic) or `broadcast`.** Open mic meshes
  every speaker with every other. Broadcast has only the host publish, so
  listeners connect to the host alone and the room carries far more of them —
  but it is still peer-to-peer and still bounded by the host's uplink. Say so in
  the UI; never imply unlimited scale. The layout lives on `activity_rooms` and
  is chosen at creation or in the host's edit sheet.
- **A scoreboard must cite its source.** `PUT /rooms/:id/score` requires
  `sourceName` and the score is always returned with it. A score with no source
  is a rumour; the route refuses the write rather than storing an unattributed
  one. Same rule for a room's `dataSource`.
- **The realtime hub is indexed, not scanned.** `RealtimeHub` keeps `byRoom`,
  `byCircle`, `byUser` and `bySocket` maps so a fan-out costs its audience, not
  the total socket count, and join/leave are O(1). If you add a new publish
  scope, index it the same way — a scan is O(100k) per event at scale.
- **`REALTIME_BUS=postgres` is required for more than one API container.** With
  `memory`, room events only reach sockets on the same instance. The
  `PostgresBus` tags every publish with an origin id and drops its own NOTIFY
  echo, because Postgres delivers a NOTIFY back to the sender and the hub
  already delivered locally. Set `REALTIME_MAX_SOCKETS` per instance and read
  `/v1/health/realtime` for autoscaling. The same seam takes Redis later.
- **Realtime clients must honour the close code.** 4401 means the session is
  gone (stop reconnecting), 4429 means the instance is at capacity (back off
  longer). Ignoring the code loops a revoked session forever and hammers a
  saturated instance.
- **Sessions are cached briefly.** `resolveSession` caches by token hash for a
  few seconds (`SESSION_CACHE_TTL_MS`), off under `NODE_ENV=test`. A logout
  calls `invalidateSession` so a revoked token stops immediately. Do not extend
  the TTL without accepting a revocation window.
- **Multi-instance background work must claim rows atomically.** `drainOutbox`
  uses `FOR UPDATE SKIP LOCKED` and bumps `attempts` before sending, so two
  instances never email the same person twice. Any future cron-style job needs
  the same treatment.
- **Security headers are app-level and cannot lock out the server.** `app.ts`
  sets CSP, nosniff, X-Frame-Options and Permissions-Policy on every response,
  and HSTS only when `x-forwarded-proto` is https. None of it touches SSH, ufw,
  or the Docker firewall — a "harden the app" request must not change host
  access. `/v1/openapi.json` documents every route; the CSP is strict because the
  API and web client are same-origin (one image).
