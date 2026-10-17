# Launch runbook

What to make available, what to set, and what to check before Vibe takes real
users. Written for the actual deployment target: **one server, Coolify, one
application container plus one PostgreSQL database.**

## First: this app does not use Supabase

The Viral Scale & Revenue plan (v1.0) assumes a self-hosted Supabase stack:
Supabase Auth, PostgREST, Realtime, Storage, Deno Edge Functions and Supavisor.

None of that is used here. This repository is a **Fastify 5 + `pg` modular
monolith**. It has:

- its own session auth (scrypt password hashing, hashed session tokens),
- its own HTTP API (169 routes) instead of PostgREST,
- its own WebSocket hub (`/v1/realtime`) instead of Supabase Realtime,
- a media boundary whose current implementation is local disk, not Storage,
- no Deno runtime anywhere.

Consequences for the plan, stated plainly:

- The plan's Deno/Edge Functions sections (§3, §9, Stage 2) do not apply. There
  is no Edge Runtime to scale or secure.
- The plan's Supavisor/pooler sections (§3) do not apply as written. This app
  opens a `pg` pool directly; the equivalent control is `PGPOOL_MAX` below.
- The plan's RLS sections (§9) do not apply. Authorization is enforced in the
  application layer (per-object checks in each module), not by Postgres RLS.
  That is a real difference: there is no second line of defence if an
  application query is wrong, so review those queries carefully.
- The plan's Storage/CDN sections (§6) are still relevant, because media is
  currently local disk and must move to object storage before scale.

You can still run a second Supabase container on the same server for something
else; it just would not be part of Vibe.

## Can one server run another database container?

Yes, technically — Coolify can run a second Postgres/Supabase container beside
the existing one. The limits that matter are not "can it run", but:

- **RAM.** Postgres sizes its cache from available memory. Two databases on one
  box each think they own it, and the kernel OOM-killer picks a victim. Pin
  `shared_buffers` and container memory limits on both.
- **Disk.** Two datasets share one disk, and both want WAL and backups. Check
  free space before adding a second one.
- **IOPS.** A shared disk means a heavy query in one database slows the other.

For Vibe specifically, **you do not need Supabase at all.** Use a plain
PostgreSQL container (or a managed Postgres if you later move off the box).
That is simpler, smaller, and is what the app is written against.

Recommended on one server: Coolify + one `postgres:16` container with a named
volume + one Vibe container built from the repo `Dockerfile`.

## Environment variables to go live

Copy `.env.example` and set these. The API refuses to start with
`NODE_ENV=production` if any required value is missing or still a dev default.

### Required

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Set last; see "soft launch" below. |
| `PORT` | `12000` | The container port; Coolify maps it. |
| `DATABASE_URL` | `postgres://user:pass@host:5432/vibe` | The Coolify Postgres internal URL. |
| `SESSION_SECRET` | `openssl rand -hex 32` | Refused if left at the dev default. |
| `CORS_ORIGIN` | `https://your-domain` | Refused as `*` in production. |
| `PUBLIC_API_URL` | `https://api.your-domain` | Used in webhook URLs. |
| `PUBLIC_WEB_URL` | `https://your-domain` | Used in password-reset links. |
| `PAYMENTS_PROVIDER` | `bachs` | `stub` is refused in production. |
| `PAYMENTS_WEBHOOK_SECRET` | from Bachs | |
| `BACHS_API_KEY` | from Bachs | |
| `BACHS_WEBHOOK_SECRET` | from Bachs | |
| `BACHS_BASE_URL` | `https://api.bachs.io` | Sandbox is `https://sandbox-api.bachs.io`. |
| `EMAIL_API_KEY` | from your email provider | Refused unset in production. |
| `EMAIL_FROM` | `Vibe <no-reply@your-domain>` | Must be a domain you can send from. |
| `EMAIL_BASE_URL` | `https://api.resend.com` | Resend-compatible JSON API. |

### Optional

| Variable | Default | Notes |
|---|---|---|
| `REDIS_URL` | unset | Configured but not currently used by any code path. Leave unset. |
| `SESSION_TTL_SECONDS` | `604800` | 7 days. |
| `PGPOOL_MAX` | `10` | Pool size. On one box, keep it small. |

### Soft launch without commerce

You can launch before Bachs is live by **not setting `NODE_ENV=production`**.
The image runs, serves both tiers, and checkout stays stubbed. This is the
intended path for a pilot. Set `NODE_ENV=production` once payments and email are
configured.

### Switching payments to live (real money)

The Bachs adapter is already built and tested (`payments/provider.ts`, covered
by `tests/bachs-provider.test.ts`), so going live is a **configuration change,
not a code change**. It needs the merchant's own credentials — no one else can
supply these, and the code deliberately refuses to start without them.

1. Get these four values from the **merchant's** Bachs dashboard (the account
   that will receive the money, not a shared or test account):
   - `BACHS_API_KEY` — the secret API key (`sk_live_…`).
   - `BACHS_WEBHOOK_SECRET` — the webhook signing secret. This is **not**
     `PAYMENTS_WEBHOOK_SECRET`; when the provider is `bachs` the app reads the
     Bachs secret and ignores the stub one.
   - `BACHS_BASE_URL` — `https://api.bachs.io` for live (sandbox is
     `https://sandbox-api.bachs.io`).
2. In the Bachs dashboard, set the webhook endpoint to
   `https://<PUBLIC_API_URL>/v1/webhooks/payments`. The app verifies
   `X-Bachs-Signature-V2` (`t=<ts>,v1=<hmac>`) over the exact raw body, so the
   secret must match the one on that endpoint.
3. Set `PAYMENTS_PROVIDER=bachs` and the values above in the deploy environment.
4. **Verify in sandbox first.** Run with `BACHS_BASE_URL=https://sandbox-api.bachs.io`
   and the sandbox key, and walk one real checkout end to end. Confirm the order
   flips to `paid` **only** after the webhook lands — never on the redirect.
5. Only then point `BACHS_BASE_URL` at live and swap in the live key.

**What must not change:** no code path may mark a payment, purchase or top-up
complete without a signature-verified webhook. The checkout redirect is a hint,
not proof. If a launch request says "make payments live", the answer is the
configuration above plus the merchant's credentials — not new code, and not a
relaxed config guard.

## Coolify steps

1. New resource → Application → connect the `abstractdevelopers/Vibe` repo.
2. Build pack: **Dockerfile** (the repo root `Dockerfile`).
3. Port: `12000`.
4. Add the environment variables above.
5. Add a domain. Coolify gives you a temporary `*.sslip.io` (or similar) host
   before you point your own DNS. **Test on that first.**
6. Add the Postgres resource, and paste its internal connection string into
   `DATABASE_URL`.
7. Deploy. The container runs migrations on boot, then starts the API.
8. Healthcheck path: `/health`.

### The HTTPS requirement for GPS

Browser geolocation only works in a **secure context**. Set the app's domain to
`https://<host>.sslip.io` rather than `http://…` and Coolify's Traefik will get a
Let's Encrypt certificate for that host over the HTTP-01 challenge, so you can
exercise the "Use my location" button in Explore before any real DNS exists.
Verified working. On a plain-HTTP host the button silently does nothing —
everything else still works.

Note: the domain is edited through the API's `domains` field. `fqdn` is
read-only and returns "This field is not allowed".

## Server hardening

Do this before the server holds anything real. The first two items are not
optional polish: on a fresh box, Docker and ufw together leave the whole
container surface exposed.

**1. Docker publishes ports past ufw.** ufw only filters the host `INPUT`
chain. A published container port is DNAT-ed in the `nat` table and then passes
through `FORWARD`, which never touches `INPUT`, so it stays reachable no matter
what `ufw status` claims. Coolify publishes 80, 443, 6001, 6002, 8000 and
Traefik's dashboard on 8080; the last one is a live admin UI you do not want on
the public internet. Restrict them in `DOCKER-USER`, the supported hook, and
persist the rules with a systemd unit so they survive a reboot.

Match on the **original** destination port, not `--dport`. Docker rewrites
`8000 -> 8080` during DNAT, so `--dport 8000` never matches and `--dport 8080`
would also let the dashboard in:

```
iptables -A DOCKER-USER -i eth0 -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN
iptables -A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 80 -j RETURN
iptables -A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 443 -j RETURN
iptables -A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 8000 -j RETURN
iptables -A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 6001 -j RETURN
iptables -A DOCKER-USER -i eth0 -p tcp -m conntrack --ctorigdstport 6002 -j RETURN
iptables -A DOCKER-USER -i eth0 -p udp -m conntrack --ctorigdstport 443 -j RETURN
iptables -A DOCKER-USER -i eth0 -j DROP
```

**2. SSH: keys only.** `PermitRootLogin prohibit-password`,
`PasswordAuthentication no`. Keep an existing session open while you reload
sshd, and verify a *new* key-based connection before closing it.

**3. Rotate any credential that was shared over chat.** A password pasted into
a conversation should be treated as compromised.

**4. The container needs `curl`.** Coolify's rolling deploy probes the
container with curl. `node:22-slim` does not ship one, so the deploy is marked
unhealthy and rolled back even when the app started and migrated correctly. The
runtime stage installs it.


## Post-deploy checks

Run these against the deployed URL.

```bash
# 1. Health (also what Coolify polls)
curl -s https://your-domain/health

# 2. The app is serving the client too
curl -s -o /dev/null -w '%{http_code}\n' https://your-domain/

# 3. A deep link returns index.html, not a 404
curl -s -o /dev/null -w '%{http_code}\n' https://your-domain/reset

# 4. The API is reachable
curl -s https://your-domain/v1/health

# 5. Migrations applied
#    (in Coolify's container terminal)
npm run migrate
```

Then, by hand:

- Register a new account and log in.
- Log out and use "Forgot your password?" — confirm the email arrives and the
  link sets a new password.
- Confirm an old session is rejected after a password reset.
- Create a post, react, comment.
- Open Explore and confirm the "Use my location" button works (HTTPS only).
- Open Live Now and join a room.

## Operational gaps to close before real traffic

These are known and deliberately not built yet. They matter at scale, not for a
pilot.

1. **Media is local disk.** Uploaded images live inside the container and are
   lost on redeploy. Move to S3-compatible object storage before you care about
   them. The boundary is `MediaStore` in `apps/api/src/modules/media.ts`.
2. **Rate limiting is database-backed.** Fine for one instance. If you ever run
   two containers, move it to Redis (`apps/api/src/modules/ratelimit.ts`).
3. **No error tracking.** Add Sentry or equivalent; you currently get structured
   request logs only.
4. **Backups.** Postgres backups and a **rehearsed restore**. An untested backup
   is not a backup.
5. **No read replicas or pooling layer.** One box is one box.
6. **Legal.** NDPA 2023 data-protection review and a privacy policy for Nigeria.
7. **Moderation staffing.** Official hosts escalate to a human queue; someone
   has to work it.

## Where the scale plan maps onto this codebase

| Plan section | Applies? | Where |
|---|---|---|
| §2 separate traffic paths | Partly | One container; split the worker timer out first when you grow. |
| §3 Supabase topology | **No** | Not a Supabase app. |
| §4 Postgres data design | Yes | Cursor pagination and indexes already in place. |
| §5 Realtime | Yes | `apps/api/src/realtime.ts`, room-scoped channels. |
| §6 Media/CDN | Yes, not built | `MediaStore` boundary is the seam. |
| §7 Durable jobs | Partly | Email outbox exists; other work is synchronous. |
| §9 Security/RLS | Partly | App-layer authorization, no RLS. |
| Part B monetization | Yes | Ledger work is not started; see `docs/spec-coverage.md`. |
