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

## Configuration

The API reads configuration from environment variables (see `.env.example`).
Production refuses to boot when either of these is left at a development value:

- `SESSION_SECRET` must be a strong, unique value.
- `PAYMENTS_PROVIDER` must not be `stub`. Set it to `bachs` and supply
  `BACHS_API_KEY` (and `BACHS_WEBHOOK_SECRET`) to run with the real provider.

Required variables: `DATABASE_URL`, `SESSION_SECRET`, `PAYMENTS_PROVIDER`,
`PAYMENTS_WEBHOOK_SECRET`, `PUBLIC_API_URL`. Add `NODE_ENV=production` only when
the payment provider gate below is satisfied.

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
