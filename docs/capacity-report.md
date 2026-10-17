# Capacity and latency report

Measured, not estimated. Every number below comes from running the real API
process against a real PostgreSQL 16 database and driving it with a black-box
load client. Where a number is a target rather than a measurement it is labelled
as such.

## How it was measured

- **Build under test:** `apps/api` at this commit, run as `tsx src/server.ts`
  (the same entry point the container uses), one process, `PGPOOL_MAX=10`.
- **Database:** `postgres:16` in a container on the same host.
- **Machine:** 4 vCPU (AMD EPYC 9B14), 16 GB RAM, containerised.
- **Client:** Node.js `ws` + `fetch` on the same host, one client process.
- **Sockets:** real `/v1/realtime` connections authenticated with a real session
  token. **Fan-out:** one real `POST /v1/activities/rooms/:id/reactions`, which
  calls `ctx.hub.publishToRoom`, with 1000 sockets present in that room.
- **HTTP:** 200 sequential-issue requests per path, all in flight at once
  (concurrency 50 per path), timed end to end including body read.

The probe scripts are not kept in the repo; they are throwaway drivers of the
public routes, and the run is reproducible from the description above.

## Results

### Realtime sockets

| Sockets held | Errors | Notes |
|---|---|---|
| 2,000 | 0 | |
| 3,100 | 0 | |
| 12,800 | 0 | |
| 14,000 | 0 | client-side limit reached, see below |

- **Memory cost: ~5.2 KB per socket** (RSS grew 51 MB across 10,000 sockets).
- **File descriptors: ~1 per socket** (10,043 fds at 10,000 sockets).
- The run stopped at ~14,000 live sockets because the *client* process ran out of
  ephemeral TCP ports, not because the server refused connections. The server
  stayed healthy and error-free throughout (`grep -c error` on its log: 0).
- This is a single-process, single-container figure. The hub keeps subscribers in
  an in-process `Set`, so sockets are **not** shared across containers — see the
  topology note below.

### Room fan-out

| Metric | Measured |
|---|---|
| Deliver one event to 1,000 room members | 26–38 ms |

Fan-out is a synchronous loop over the subscriber set writing to each socket.
The cost is linear in room size, so a single event to a 10,000-member room
scales to roughly 10x this figure (~0.3 s to finish writing), which is why very
large rooms should be a target for a fan-out worker rather than the request path.

### HTTP read paths

| Path | Throughput | p50 | p95 | p99 |
|---|---|---|---|---|
| `GET /v1/feed?limit=20` | 580 rps | 216 ms | 315 ms | 323 ms |
| `GET /v1/activities/rooms?limit=20` | 1,159 rps | 127 ms | 159 ms | 161 ms |

Both were measured at concurrency 50 on a 4-vCPU box that was also running the
database and the load client. `/v1/feed` is the heavier query: it runs the
ranking CTE (relationship, affinity, engagement, freshness, safety terms) plus
per-post subqueries, so it costs about 2x the rooms list.

## What this means for launch

**Comfortable.** For a launch in the low thousands of concurrent users — say
2,000 people with the app open and a few hundred in any one room — one container
holds the realtime load with room to spare: 2,000 sockets cost ~10 MB and the
server handled 12,800 without an error.

**The real ceilings, in order:**

1. **Single process.** All sockets for a room must be in the same process for
   room events to reach everyone, because the hub is in-memory. Running two API
   containers does not double room capacity; it splits it. Crossing this needs a
   shared bus (Redis pub/sub or Postgres `LISTEN/NOTIFY`) before a second
   container, and the same move takes rate limiting off the database.
2. **Fan-out is linear in room size.** Fine for hundreds; a room of tens of
   thousands needs a fan-out worker and probably a different transport (SFU) for
   voice, not the current mesh WebRTC signalling.
3. **`/v1/feed` is the hot query.** 580 rps at p95 315 ms on 4 vCPU with the DB
   on the same box is enough for launch but the first thing to optimise (or
   cache) as traffic grows.
4. **Ephemeral ports / `ulimit -n`.** The host needs `nofile` above the expected
   socket count and `net.ipv4.tcp_tw_reuse=1` so short-lived HTTP connections do
   not exhaust ports. The server process must set `ulimit -n` at start; the
   default is too low for tens of thousands of sockets.

## Honest limits of this report

- One machine, one process, database co-located. Network latency between tiers is
  not represented; a real deployment adds a few ms per request.
- The client and server shared 4 vCPUs, so HTTP latency figures are pessimistic
  (the load generator competes with the server for CPU).
- No write-path benchmark (posts, gifts, orders) and no payment webhook storm.
  Those are the next measurements to take before a large paid launch.
- Voice/video media itself never crosses the server (WebRTC mesh), so its
  capacity is bounded by the peers and their networks, not by this process —
  except that signalling rides the same hub.
