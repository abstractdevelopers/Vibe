# Vibe

Vibe is an interactive social network that turns conversations into plans,
activities, shared-expense coordination, and commerce. It is not just a chat
app, a feed, or a wallet.

This repository implements the first engineering sprint described in the
[Vibe product & engineering specification](docs/first-sprint-design-note.md):
one complete vertical slice where a user can create a Circle, invite friends,
post a poll, vote, plan an outing, and record a shared expense — without Vibe
ever holding money.

## Repository layout

```
apps/api            Fastify + PostgreSQL API (modular monolith)
apps/web            Responsive React client (Vite)
packages/shared     Money math and shared domain vocabulary
docs/               Design notes
```

## Requirements

- Node.js 22+ (developed on Node 24)
- Docker (for PostgreSQL and Redis) — or your own Postgres/Redis

## Getting started

```bash
npm install
cp .env.example .env          # adjust if needed
npm run db:up                 # starts Postgres + Redis via docker compose
npm run migrate               # applies SQL migrations
npm run dev:api               # API on http://localhost:12000
npm run dev:web               # web client on http://localhost:12001
```

Health check: `curl http://localhost:12000/health`.

## Scripts

| Command | Description |
|---|---|
| `npm run db:up` / `npm run db:down` | Start / stop Postgres and Redis |
| `npm run migrate` | Apply migrations (idempotent, checksum-verified) |
| `npm run dev:api` | Run the API with reload |
| `npm run dev:web` | Run the web client |
| `npm run test` | Run the API test suite (unit + integration) |
| `npm run typecheck` | Type-check the API and web workspaces |
| `npm run build` | Production build of the web client |

The test suite needs a reachable database (the `db:up` container is fine). It
truncates tables between tests, so point `DATABASE_URL` at a scratch database.

## What works today

- **Identity** — email + password sign-up, scrypt hashing, bearer sessions,
  editable profile (name, handle, bio, interests, city/area) and granular
  privacy settings.
- **Circles** — membership with owner/admin/moderator/member roles, expiring
  and usage-capped invites, leave and ownership rules.
- **Feed** — a flat editorial stream of posts with text, polls and images,
  comments, reactions, cursor pagination, server-side audience authorization,
  block and mute.
- **Media** — image upload with magic-byte validation, served locally from
  `/v1/media/<id>` (a stub store; swap in object storage later).
- **Discovery (Explore)** — explainable ranking over places and discoverable
  plans by area, interests and relationships, plus people search. Every result
  says why it ranked.
- **Polls** — one vote per user enforced in the database, a poll state machine,
  and realtime result updates.
- **Plans** — RSVP states including waitlisting, with notifications.
- **Shared expenses** — equal, custom, percentage and itemized splits that sum
  to the total exactly; an auditable status history where a reported payment is
  never the same as a verified one; idempotent writes.
- **Moderation** — reporting, an admin queue, and an audit log.
- **Payments boundary** — a stub provider and a signature-verified,
  deduplicated webhook inbox. No real provider calls, no fake payment state.

## Design constraints honoured

- No custody: Vibe holds no funds, no stored-value balance, no P2P transfer.
- No device location: place discovery uses a city and area label the user types;
  there is no geolocation call and no coordinate column.
- Money is integer minor units; no floating-point arithmetic.
- Reported payments never become verified without a trustworthy confirmation.
- Private content is authorized on the server, never by client filtering.
- Payment, purchase and attendance state is never optimistically marked
  complete.
- No dead-end screens: every surfaced action works end to end.
