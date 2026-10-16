# Deploy and rollback

Vibe ships as a single container image. The API serves the built web client from
the same origin in production, so there is no separate static host and no
cross-origin configuration to keep in sync.

## Build

```
docker build -t vibe:<version> .
```

The image runs migrations on boot (`npm run migrate`) and then starts the API.
Migrations are append-only and idempotent, so a restart never re-applies one.

The runtime stage copies the whole tree with `COPY . .`. Do not "tidy" that into
`COPY apps packages scripts ./`: a multi-source COPY copies the *contents* of
each directory into the destination, so the image would end up with `/app/api`
and no `/app/apps/api`, migration would fail with `ERR_MODULE_NOT_FOUND`, and
the node_modules workspace symlinks would dangle.

## Configuration

The API reads configuration from environment variables (see `.env.example`).
Production refuses to boot when either of these is left at a development value:

- `SESSION_SECRET` must be a strong, unique value.
- `PAYMENTS_PROVIDER` must not be `stub`. Set it to `bachs` and supply
  `BACHS_API_KEY` (and `BACHS_WEBHOOK_SECRET`) to run with the real provider.

Required variables: `DATABASE_URL`, `SESSION_SECRET`, `PAYMENTS_PROVIDER`,
`PAYMENTS_WEBHOOK_SECRET`, `PUBLIC_API_URL`, `PUBLIC_WEB_URL`, `CORS_ORIGIN`.
Add `NODE_ENV=production` only when the payment and email gates below are
satisfied.

Production also refuses to boot when:

- `CORS_ORIGIN` is `*` (set it to your web origin),
- `EMAIL_API_KEY` is unset (password reset cannot deliver without a mailer).

See `docs/launch-runbook.md` for the full variable list and a Coolify walkthrough.
Note that this app is **not** a Supabase application: it is a Fastify + `pg`
monolith with its own auth, HTTP API and WebSocket hub. The scale plan's
Supabase/Deno/Supavisor/RLS sections do not apply.

## Transactional email

Password reset writes to an `email_outbox` table inside the same transaction
that creates the token, and an interval timer drains it every 15 seconds. The
mailer is selected by `EMAIL_API_KEY`: unset means the log mailer (development),
set means an HTTP call to a Resend-compatible endpoint. Production requires it,
because a user who cannot receive a reset email cannot recover their account.

## Payments (Bachs)

`PAYMENTS_PROVIDER=bachs` selects the Bachs adapter in
`apps/api/src/payments/provider.ts`. It:

- creates a hosted checkout session at `BACHS_BASE_URL` (sandbox
  `https://sandbox-api.bachs.io`, production `https://api.bachs.io`) using
  `BACHS_API_KEY`, and returns the `checkout_url` for the buyer;
- verifies every webhook against `X-Bachs-Signature` / `X-Bachs-Timestamp`
  (HMAC-SHA256 of `"{timestamp}.{raw_body}"`, 300 s replay window).

An order is only marked paid when a signature-verified webhook says so. A
redirect or browser event never does. Configure the Bachs webhook destination at
`{PUBLIC_API_URL}/v1/webhooks/payments` and subscribe to at least
`collection.succeeded`, `collection.failed` and `refund.paid`.

Related variables: `BACHS_API_KEY`, `BACHS_WEBHOOK_SECRET`, `BACHS_BASE_URL`,
`PUBLIC_WEB_URL`.

The image deliberately does not set `NODE_ENV`. That keeps the "no production
release while payments are stubbed" gate honest: setting `NODE_ENV=production`
without a configured provider makes the process exit at startup, by design. The
image is otherwise complete and serves both tiers. Set `NODE_ENV=production`
only once `PAYMENTS_PROVIDER=bachs` and its credentials are in place.

## Single origin

When `apps/web/dist` exists in the image, the API serves it: static assets, and
an SPA fallback so a deep link like `/settings` returns `index.html`. Requests
under `/v1/` and `/health` keep returning JSON, including 404s. This is what
makes a single image enough.

## Deploy

1. Tag the image with the commit SHA: `vibe:$(git rev-parse --short HEAD)`.
2. Push the image to the registry.
3. Roll the running service to the new tag.
4. Wait for the container healthcheck (`GET /health`) to pass before shifting
   traffic. A container that fails its healthcheck is not promoted.

## Rollback

Deploys are immutable images, so a rollback is a re-point, not a rebuild:

1. Re-point the service to the previous known-good image tag.
2. Restart. The boot step detects already-applied migrations and skips them.

Migrations are forward-only. A rollback therefore never reverses a schema
change; it restores the previous application code, which must remain compatible
with the newer schema. Keep schema changes backward-compatible for one release
(add columns, do not drop them) so a rollback is always safe.

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request:

1. `npm run typecheck` — both workspaces.
2. `npm run migrate` against a throwaway PostgreSQL service.
3. `npm test` — the API test suite.
4. `npm run build` — the web client.
5. `npm run check-bundle` — fails if the bundle exceeds its budget.

The bundle budget is defined in `scripts/check-bundle.mjs`: 120 kB gzipped and
400 kB raw for JavaScript, 20 kB gzipped for CSS. Raise a budget only with a
deliberate decision, in the same change that needs it.
