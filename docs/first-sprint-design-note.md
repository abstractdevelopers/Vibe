# Vibe — First engineering sprint design note

Companion to the VIBE Product & Engineering Specification v1.0. This note covers
the modules built in the first sprint: identity, Circles, feed, polls, plans,
shared expenses, moderation, payments boundary. Each section gives the schema,
API contract, state machine, permissions, and test coverage.

## Scope

The sprint goal is one complete vertical slice: a user can create a Circle,
invite friends, post an activity, vote, plan a real outing, and record a shared
expense without Vibe holding money. Everything below ships working end to end,
including loading, empty, error and permission-denied states.

Out of scope for this sprint (per spec): orders/checkout product, advertising
delivery, NFC/QR pass, AI assistance. The payment provider boundary exists as a
stub so Phase 3 can plug in a provider without changing call sites.

## Architecture

Modular monolith. `apps/api` (Fastify + PostgreSQL) holds the modules; each
module owns its routes and queries. `packages/shared` holds the money math and
state-machine vocabulary so the client and server cannot drift. `apps/web` is a
responsive React client for shareable pages and merchant/admin tools.

- Identifiers: UUID. Timestamps: `timestamptz` in UTC, with the original IANA
  time zone stored on plans for display.
- Money: integer minor units in `BIGINT`, explicit ISO 4217 currency code. No
  floating point anywhere in the money path.
- Auth: scrypt password hashes, opaque bearer session tokens stored hashed.
- Realtime: in-process hub; events are notifications of committed changes, never
  the source of truth. Every subscription is scoped to the Circles a user is in.

## Module: Identity

**Schema.** `users`, `sessions`.

**API.**
| Method | Route | Notes |
|---|---|---|
| POST | `/v1/auth/register` | email + handle + password; returns token |
| POST | `/v1/auth/login` | |
| POST | `/v1/auth/logout` | revokes the session |
| GET | `/v1/me` | profile + privacy |
| PATCH | `/v1/me` | display name, handle, bio, avatar, city/area, interests |
| PATCH | `/v1/me/privacy` | granular privacy flags |

**Permissions.** Self only. No contacts or location requested at sign-up.

**Test coverage.** `tests/vertical-slice.test.ts` (registration, session use).

## Module: Circles

**Schema.** `circles`, `circle_members`, `circle_invites`.

**State / rules.**
- Roles: owner > admin > moderator > member (least privilege; rank enforced in
  `modules/access.ts`).
- Privacy: private, invite_only, public_discoverable.
- Invites: hashed token, optional expiry, optional usage cap, revocable.
- Only the owner can mint another owner; the owner cannot be demoted or removed
  by a route — ownership must be transferred.
- A member can always leave; expense records remain visible to participants.

**API.**
| Method | Route | Min role |
|---|---|---|
| POST | `/v1/circles` | authenticated |
| GET | `/v1/circles` | authenticated |
| GET | `/v1/circles/:id` | member |
| POST | `/v1/circles/:id/invites` | admin |
| POST | `/v1/invites/:token/accept` | authenticated |
| PATCH | `/v1/circles/:id/members/:userId` | admin (owner to mint owner) |
| DELETE | `/v1/circles/:id/members/:userId` | admin |
| POST | `/v1/circles/:id/leave` | member |

**Test coverage.** `tests/vertical-slice.test.ts` (create, invite, accept, role
checks); `tests/authorization.test.ts` (private post visibility).

## Module: Feed and posts

**Schema.** `posts`, `post_media`, `comments`, `reactions`, `follows`, `blocks`,
`mutes`.

**Visibility rule.** `modules/feed.ts::visiblePosts` is the single place feed
visibility is decided. It excludes blocked and muted authors, restricts
non-public audiences, and uses server-side authorization — the client never
filters private content. Cursor pagination uses `(created_at, id)` for a stable
order with no duplicates.

**API.** `POST /v1/posts`, `GET /v1/feed`, `GET /v1/users/:id/posts`,
`POST /v1/posts/:id/reactions`, `GET|POST /v1/posts/:id/comments`,
`POST|DELETE /v1/users/:id/block`, `GET /v1/users/blocked`.

**Test coverage.** `tests/authorization.test.ts` (Circle-only visibility, block
hiding, pagination without duplicates).

## Module: Polls (activities)

**Schema.** `activities`, `poll_options`, `votes`.

**State machine.** `draft → open → closed → results_published`, plus
`cancelled` and `under_review`. A poll accepts votes only while `open` and
before `ends_at`.

**Vote rule.** One vote per user, enforced by the `votes` primary key
`(activity_id, user_id)`, not only in application code. A second vote returns
409. Results are computed from stored rows, so they are reproducible.

**API.** `POST /v1/activities`, `GET /v1/activities/:id`,
`POST /v1/activities/:id/votes`, `POST /v1/activities/:id/close`,
`POST /v1/activities/:id/publish-results`.

**Realtime.** A vote publishes `poll.results_updated` to the Circle.

**Test coverage.** `tests/vertical-slice.test.ts` (vote, duplicate vote 409,
non-member 403).

## Module: Plans and RSVPs

**Schema.** `plans`, `rsvps`, `notifications`.

**State machine.** `draft → proposed → confirming → confirmed → completed`, or
`cancelled`.

**RSVP states.** interested, going, waitlisted, declined, checked_in. When a
participant limit is set, an over-limit "going" is recorded as `waitlisted`.

**API.** `POST /v1/plans`, `GET /v1/plans/:id`, `POST /v1/plans/:id/rsvps`,
`PATCH /v1/plans/:id`, `POST /v1/plans/:id/cancel`.

**Notifications.** Creating or changing a plan notifies other Circle members
according to their stored preferences.

**Test coverage.** `tests/vertical-slice.test.ts` (plan, RSVP, waitlist,
notification fan-out).

## Module: Shared expenses

**Schema.** `expenses`, `expense_participants`, `expense_events`,
`payment_reports`.

**Non-negotiables.** V1 is a ledger of obligations and reported/verified payment
events. Vibe holds no funds and creates no stored-value balance.

**Split math.** `packages/shared/src/money.ts`. Equal, custom, percentage and
itemized splits all validate that allocations sum to the total exactly, using
largest-remainder rounding so the result is deterministic and shown to the user.

**Allocation status machine.**
```
proposed → accepted → due → payment_reported → payment_verified → settled
proposed → payment_reported            (accepted is only required when a Circle asks)
due → disputed | waived | cancelled
payment_reported → disputed
payment_verified → disputed
disputed → due | payment_verified | settled | cancelled
```
"reported" and "verified" are distinct states. Reporting a payment never
verifies it. Only the payer or a Circle admin can verify, and verification
records its source. Corrections are new `expense_events` rows, never silent
edits.

**Idempotency.** `POST /v1/expenses` and `POST /v1/expenses/:id/payment-reports`
require an `Idempotency-Key`; a replay with the same body returns the stored
response instead of duplicating the write.

**API.** `POST /v1/expenses`, `GET /v1/expenses/:id`,
`GET /v1/expenses/:id/events`, `POST /v1/expenses/:id/payment-reports`,
`POST /v1/expenses/:id/payment-reports/:reportId/verify`,
`POST /v1/expenses/:id/participants/:userId/status`.

**Test coverage.** `tests/money.test.ts` (split math), `tests/vertical-slice.test.ts`
(exact sum, idempotent replay, reported ≠ verified, audit trail).

## Module: Reports and moderation

**Schema.** `reports`, `moderation_cases`, `moderation_actions`, `audit_events`.

**API.** `POST /v1/reports`; admin-only `GET /v1/admin/reports`,
`POST /v1/admin/reports/:id/action`, `POST /v1/admin/reports/:id/dismiss`,
`GET /v1/admin/audit`. Every admin action is role-checked and written to the
audit log.

**Test coverage.** `tests/authorization.test.ts` (report, non-admin 403, action
removes post, audit entry written).

## Module: Media

**Boundary.** `modules/media.ts` accepts an image data URL, decodes it, and
validates the magic bytes before writing. It rejects anything that is not a real
image (a `text/html` payload dressed as a data URL fails), so the store can
never serve a script. Files are served from `GET /v1/media/<id>`.

**Storage.** `DiskMediaStore` writes to a local directory — a stub, so the
project needs no new dependency and no bucket credentials. Swapping in object
storage means implementing the same `MediaStore` interface; call sites do not
change.

**Posts.** `createPostSchema` accepts media as an absolute `http(s)` URL or our
own `/v1/media/<id>` path, and nothing else. A post therefore cannot smuggle in
a `javascript:` URL. Media is stored in `posts.metadata.mediaUrls` and returned
on every feed item.

**API.** `POST /v1/media`, `GET /v1/media/:id`.

**Test coverage.** `tests/discovery-media.test.ts` (store and serve, reject a
non-image, require auth, media round-trips through the feed, reject an
executable URL).

## Module: Discovery (Explore)

**Schema.** `places` (migration `0002_discovery.sql`), plus `city`/`area`
columns on `users` and `plans` and supporting indexes.

**Location rule.** Location is a city and area label a person types — never a
device fix. There is no `navigator.geolocation` call and no coordinate column
anywhere in the schema. This keeps the slice inside the spec's location
constraints while still ranking by place.

**Ranking.** `modules/discovery.ts` scores places and discoverable plans with
explainable weights: area match, interest affinity, relationship (a followed
organizer or a joined Circle), recency, and verification. Every result returns
the `reasons` that produced its score, so the UI never shows a ranked item
without saying why.

**Sources.** Places are seeded as clearly-labelled sample data (`isSample`),
not fabricated third-party listings. Discoverable plans surface as events with
their organizer.

**API.** `GET /v1/explore` (query, city, category, kind, limit), plus
`GET /v1/places/:id` and the existing `GET /v1/search/users`.

**Test coverage.** `tests/discovery-media.test.ts` (same-area interest match
outranks an unrelated place, city filter, a discoverable plan surfaces as an
event, a non-discoverable plan does not).

## Module: Payments boundary

**Stub provider.** `apps/api/src/payments/provider.ts`. Performs no network
calls and always reports that nothing has been charged. Swapping in a real
provider means implementing the same interface.

**Webhooks.** `POST /v1/webhooks/payments` verifies the signature before
trusting the payload, then writes to a `provider_webhook_events` inbox whose
primary key `(provider, event_id)` makes redelivery a no-op. A checkout attempt
is never treated as a completed payment.

**Test coverage.** `tests/authorization.test.ts` (unsigned 401, signed 202,
duplicate ignored).

## Cross-cutting

- **Error envelope.** `{ error: { code, message, requestId, fieldErrors? } }`.
- **Money.** Integer minor units only; see `packages/shared/src/money.ts`.
- **Accessibility.** Minimum 44×44 touch targets, visible focus rings, reduced
  motion support, light and dark themes, colour never the only state signal.
- **Definition of done.** Loading, empty, error and permission-denied states are
  implemented in the client; state transitions, retries and duplicate events are
  covered by tests.
