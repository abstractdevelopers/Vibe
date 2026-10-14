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

## Do not

- Introduce floating-point money arithmetic.
- Mark a payment, purchase or check-in complete without server confirmation.
- Add dead-end UI: if a button is shown, it must work.
- Break existing API contracts without a migration plan.
