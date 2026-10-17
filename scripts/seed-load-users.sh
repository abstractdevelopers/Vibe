#!/usr/bin/env bash
# Mint throwaway identities for the room load test (scripts/room-loadtest.mjs).
#
# Signup is rate limited to 10/hour per IP on purpose, so a load test cannot
# create hundreds of accounts over HTTP. This seeds them straight into the local
# database instead, and writes the plaintext tokens to a file the load test
# reads via LOAD_TOKENS.
#
# Local only. It talks to the docker-compose Postgres, never production.
#
# Usage: scripts/seed-load-users.sh [count] [outfile]
set -euo pipefail

COUNT="${1:-200}"
OUT="${2:-/tmp/vibe-load-tokens.json}"
PG_CONTAINER="${PG_CONTAINER:-vibe-pg}"
PG_USER="${PG_USER:-vibe}"
PG_DB="${PG_DB:-vibe}"

SQL_FILE="$(mktemp)"
python3 - "$COUNT" "$OUT" "$SQL_FILE" <<'PY'
import hashlib, json, secrets, sys
n, out, sqlfile = int(sys.argv[1]), sys.argv[2], sys.argv[3]
tokens = [secrets.token_hex(24) for _ in range(n)]
lines = ["BEGIN;"]
for i, tok in enumerate(tokens):
    h = hashlib.sha256(tok.encode()).hexdigest()
    lines.append(
        "WITH u AS (INSERT INTO users (email, handle, display_name, password_hash) "
        f"VALUES ('load-{i}@vibe.test', 'load{i}', 'Load {i}', 'x') RETURNING id) "
        f"INSERT INTO sessions (user_id, token_hash, expires_at) "
        f"SELECT id, '{h}', now() + interval '6 hours' FROM u;"
    )
lines.append("COMMIT;")
open(sqlfile, "w").write("\n".join(lines) + "\n")
open(out, "w").write(json.dumps(tokens))
PY

docker exec -i "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -q -v ON_ERROR_STOP=1 < "$SQL_FILE"
rm -f "$SQL_FILE"
echo "seeded $COUNT users; tokens -> $OUT"
echo "run: LOAD_TOKENS=$OUT node scripts/room-loadtest.mjs <baseUrl> $COUNT $COUNT"
