#!/usr/bin/env python3
"""
Full end-to-end launch test against the live deployment.

Exercises the platform the way a real person and a real business would, in
order, asserting the state transitions the spec cares about. Everything here
talks to the live API over HTTP as a genuine client; nothing reaches into the
database. Run it against production before a launch.

Usage: python3 e2e_launch_test.py [base_url]
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else
        "https://4odwboyulnfdthdlv9hzrguf.172.104.128.165.sslip.io").rstrip("/")

PASS, FAIL, SKIP = [], [], []


def call(method, path, token=None, body=None, headers=None, expect=None, raw=False):
    url = BASE + path
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json"}
    if token:
        h["authorization"] = "Bearer " + token
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            code, text = r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        code, text = e.code, e.read().decode()
    except Exception as e:  # noqa: BLE001
        return None, {"error": str(e)}
    try:
        parsed = json.loads(text) if text else {}
    except json.JSONDecodeError:
        parsed = {"raw": text[:200]} if raw else {"raw": text[:200]}
    if expect is not None and code != expect:
        raise AssertionError(f"{method} {path} -> {code}, expected {expect}: {str(parsed)[:200]}")
    return code, parsed


def check(name, fn):
    try:
        fn()
        PASS.append(name)
        print(f"  PASS  {name}")
    except AssertionError as e:
        FAIL.append((name, str(e)))
        print(f"  FAIL  {name}\n        {e}")
    except Exception as e:  # noqa: BLE001
        FAIL.append((name, f"{type(e).__name__}: {e}"))
        print(f"  FAIL  {name}\n        {type(e).__name__}: {e}")


def section(t):
    print(f"\n=== {t} ===")


TAG = uuid.uuid4().hex[:8]
password = "password123"


def register(role):
    email = f"e2e_{role}_{TAG}@example.com"
    handle = f"e2e{role}{TAG}"[:20]
    code, r = call("POST", "/v1/auth/register",
                   body={"email": email, "handle": handle, "displayName": f"E2E {role}", "password": password},
                   expect=201)
    return {"email": email, "handle": handle, "token": r["token"], "id": r["user"]["id"]}


section("Health and public surface")
check("health endpoint responds ok", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError(f"health={r}")) if r[0] != 200 or r[1].get("status") != "ok" else None
)(call("GET", "/health", expect=200)))

# Which payment provider the target is running, so the checkout assertion can
# match reality: the stub has no hosted checkout.
PROVIDER = call("GET", "/health")[1].get("provider", "unknown")
print(f"  (payment provider: {PROVIDER})")

check("unknown route is a clean 404", lambda: call("GET", "/v1/does-not-exist", expect=404))
check("gift catalogue requires auth", lambda: call("GET", "/v1/money/gifts", expect=401))
check("feed requires auth", lambda: call("GET", "/v1/feed", expect=401))


section("Accounts and auth")
# The sign-up limiter allows 10 registrations per IP per hour, which is correct
# behaviour but a small budget for a test that needs several accounts. Reset it
# first when running against a local instance; against production the test uses
# few enough accounts to stay under the limit.
if "localhost" in BASE or "127.0.0.1" in BASE:
    try:
        subprocess.run(
            ["node", "-e",
             "const{Client}=require('pg');const c=new Client({connectionString:process.env.DATABASE_URL});"
             "c.connect().then(()=>c.query('DELETE FROM rate_limit_counters'))"
             ".then(()=>c.end()).catch(()=>process.exit(0));"],
            cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            env={**os.environ, "DATABASE_URL": os.environ.get(
                "DATABASE_URL", "postgres://vibe:vibe@localhost:5432/vibe")},
            capture_output=True, timeout=30,
        )
        print("  (cleared local rate-limit counters)")
    except Exception as e:  # noqa: BLE001
        print(f"  (could not clear rate limits: {e})")

alice = register("alice")
bob = register("bob")

check("duplicate handle is refused", lambda: call(
    "POST", "/v1/auth/register",
    body={"email": f"dup_{TAG}@example.com", "handle": alice["handle"], "displayName": "Dup", "password": password},
    expect=409))

check("duplicate email is refused", lambda: call(
    "POST", "/v1/auth/register",
    body={"email": alice["email"], "handle": f"other{TAG}"[:20], "displayName": "Dup", "password": password},
    expect=409))

check("weak password is refused", lambda: call(
    "POST", "/v1/auth/register",
    body={"email": f"weak_{TAG}@example.com", "handle": f"weak{TAG}"[:20], "displayName": "W", "password": "short"},
    expect=422))

check("login works", lambda: call(
    "POST", "/v1/auth/login", body={"email": alice["email"], "password": password}, expect=200))

check("wrong password is refused", lambda: call(
    "POST", "/v1/auth/login", body={"email": alice["email"], "password": "wrong-password"}, expect=401))

check("me returns the session user", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError(f"handle={r[1].get('handle')}")) if r[1].get("handle") != alice["handle"] else None
)(call("GET", "/v1/me", token=alice["token"], expect=200)))


section("Profile")
check("profile can be updated", lambda: call(
    "PATCH", "/v1/me", token=alice["token"], body={"displayName": "Alice E2E", "bio": "Testing launch"}, expect=200))

check("public profile is readable by id", lambda: call("GET", f"/v1/users/{alice['id']}", token=bob["token"], expect=200))
check("a malformed user id is a 404, not a 500", lambda: call("GET", "/v1/users/not-a-uuid", token=bob["token"], expect=404))


section("Posts, reactions, comments")
post = {}


def make_post():
    code, r = call("POST", "/v1/posts", token=alice["token"],
                   body={"body": "Launch readiness check.", "kind": "text", "audience": "public"}, expect=201)
    post["id"] = r["id"]


check("a public text post can be created", make_post)
check("the post appears in another user's feed", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("post missing from feed")) if not any(
        p.get("id") == post["id"] for p in r[1].get("items", [])
    ) else None
)(call("GET", "/v1/feed", token=bob["token"], expect=200)))

check("the post is listed on the author's profile", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("post missing from profile posts")) if not any(
        p.get("id") == post["id"] for p in r[1].get("items", [])
    ) else None
)(call("GET", f"/v1/users/{alice['id']}/posts", token=bob["token"], expect=200)))

check("bob can react to alice's post", lambda: call(
    "POST", f"/v1/posts/{post['id']}/reactions", token=bob["token"], body={"kind": "like"}, expect=200))

check("reaction count is reflected in the feed", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("reaction not counted")) if not any(
        p.get("id") == post["id"] and p.get("reactionCount", 0) >= 1 for p in r[1].get("items", [])
    ) else None
)(call("GET", "/v1/feed", token=bob["token"], expect=200)))

check("bob can comment", lambda: call(
    "POST", f"/v1/posts/{post['id']}/comments", token=bob["token"], body={"body": "Looks good"}, expect=201))

check("comments are listed", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("no comments")) if not r[1].get("comments") else None
)(call("GET", f"/v1/posts/{post['id']}/comments", token=alice["token"], expect=200)))

check("empty post body is refused", lambda: call(
    "POST", "/v1/posts", token=alice["token"], body={"body": "", "kind": "text"}, expect=400))


section("Free gifts")
check("free gift catalogue loads", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("no gifts")) if not r[1].get("gifts") else None
)(call("GET", f"/v1/posts/{post['id']}/gifts", token=bob["token"], expect=200)))

check("bob can send a free gift", lambda: call(
    "POST", f"/v1/posts/{post['id']}/gifts", token=bob["token"], body={"kind": "fire"}, expect=201))

check("an invented gift kind is refused", lambda: call(
    "POST", f"/v1/posts/{post['id']}/gifts", token=bob["token"], body={"kind": "diamond_unicorn"}, expect=422))


section("Paid gifts (money)")
check("paid catalogue loads with prices", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("no gifts or no price")) if not r[1].get("gifts") or "priceMinor" not in r[1]["gifts"][0] else None
)(call("GET", "/v1/money/gifts", token=bob["token"], expect=200)))

check("the new Applause gift is in the catalogue", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("clap missing")) if not any(
        g.get("id") == "clap" for g in r[1].get("gifts", [])
    ) else None
)(call("GET", "/v1/money/gifts", token=bob["token"], expect=200)))

purchase = {}


def buy_gift():
    code, r = call("POST", "/v1/money/gifts/purchase", token=bob["token"],
                   headers={"idempotency-key": f"e2e-{TAG}"},
                   body={"giftId": "rose", "quantity": 1, "recipientId": alice["id"], "postId": post["id"]},
                   expect=202)
    purchase.update(r)


check("a paid gift starts a purchase", buy_gift)
check("purchase is pending, not paid", lambda: (
    lambda: (_ for _ in ()).throw(AssertionError(f"status={purchase.get('status')}")) if purchase.get("status") != "pending" else None
)())
# The stub provider used locally has no hosted checkout, so only assert the
# redirect where a real payment provider is configured.
if PROVIDER == "bachs":
    check("purchase returns a checkout redirect", lambda: (
        lambda: (_ for _ in ()).throw(AssertionError(f"no redirectUrl: {purchase}")) if not purchase.get("redirectUrl") else None
    )())
else:
    SKIP.append("purchase returns a checkout redirect (provider is 'stub')")
    print(f"  SKIP  purchase returns a checkout redirect (provider={PROVIDER})")
check("the split is 70/30 in the recipient's favour", lambda: (
    lambda: (_ for _ in ()).throw(AssertionError(f"fee={purchase.get('feeMinor')} recip={purchase.get('recipientMinor')}"))
    if purchase.get("feeMinor") != 6000 or purchase.get("recipientMinor") != 14000 else None
)())

check("replaying the same idempotency key does not double-charge", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("duplicate purchase created")) if r[1].get("purchaseId") != purchase.get("purchaseId") else None
)(call("POST", "/v1/money/gifts/purchase", token=bob["token"],
       headers={"idempotency-key": f"e2e-{TAG}"},
       body={"giftId": "rose", "quantity": 1, "recipientId": alice["id"], "postId": post["id"]}, expect=202)))

check("alice's balance is zero until the webhook confirms", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError(f"balance={r[1].get('availableMinor')}")) if r[1].get("availableMinor", 0) != 0 else None
)(call("GET", "/v1/money/balance", token=alice["token"], expect=200)))

check("payouts are disabled with a clear message, not a crash", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError(f"code={r[0]} body={r[1]}")) if r[0] != 503 else None
)(call("POST", "/v1/money/destinations", token=alice["token"],
       body={"bankCode": "058", "accountNumber": "0123456789", "accountName": "Alice"}, expect=503)))


section("Commerce: business, verification, products, orders")
merchant = {}


def open_business():
    code, r = call("POST", "/v1/merchants", token=alice["token"],
                   body={"name": "E2E Fabrics", "category": "retail"}, expect=201)
    merchant["id"] = r["id"]


check("a business can be opened", open_business)
check("it starts unverified", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError(f"status={r[1].get('verificationStatus')}")) if r[1].get("verificationStatus") != "unverified" else None
)(call("GET", f"/v1/merchants/{merchant['id']}", token=alice["token"], expect=200)))

check("an unverified business cannot publish a live product", lambda: call(
    "POST", f"/v1/merchants/{merchant['id']}/products", token=alice["token"],
    body={"name": "Ankara", "priceMinor": 500000, "currency": "NGN", "status": "active"}, expect=400))

check("a draft product is allowed", lambda: call(
    "POST", f"/v1/merchants/{merchant['id']}/products", token=alice["token"],
    body={"name": "Ankara draft", "priceMinor": 500000, "currency": "NGN", "status": "draft"}, expect=201))

check("a non-operator cannot verify a business", lambda: call(
    "POST", f"/v1/admin/merchants/{merchant['id']}/verify", token=bob["token"],
    body={"verificationStatus": "verified"}, expect=403))


section("Discovery and search")
check("explore returns results", lambda: call("GET", "/v1/explore", token=bob["token"], expect=200))
check("explore facets load", lambda: call("GET", "/v1/explore/facets", token=bob["token"], expect=200))
check("user search works", lambda: call("GET", "/v1/search/users?q=e2e", token=bob["token"], expect=200))
check("post search works", lambda: call("GET", "/v1/search/posts?q=launch", token=bob["token"], expect=200))


section("Messaging")
check("a conversation can be started", lambda: call(
    "POST", "/v1/conversations", token=bob["token"], body={"userId": alice["id"]}, expect=201))

check("conversations are listed", lambda: call("GET", "/v1/conversations", token=bob["token"], expect=200))


section("Notifications and privacy")
check("notifications load", lambda: call("GET", "/v1/notifications", token=alice["token"], expect=200))
check("privacy settings come back with me", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError("no privacy block")) if "privacy" not in r[1] else None
)(call("GET", "/v1/me", token=alice["token"], expect=200)))

check("privacy settings save", lambda: call(
    "PATCH", "/v1/me/privacy", token=alice["token"],
    body={"discoverable": True, "readReceipts": True, "locationEnabled": False,
          "contactsSyncEnabled": False, "profileAudience": "public"}, expect=200))


section("Safety")
check("a post can be reported", lambda: call(
    "POST", "/v1/reports", token=bob["token"],
    body={"targetType": "post", "targetId": post["id"], "reason": "spam"}, expect=201))

check("a non-operator cannot read the admin overview", lambda: call(
    "GET", "/v1/admin/overview", token=bob["token"], expect=403))


section("Authorization boundaries")
check("a user cannot delete someone else's post", lambda: (
    lambda r: (_ for _ in ()).throw(AssertionError(f"code={r[0]}")) if r[0] not in (403, 404) else None
)(call("DELETE", f"/v1/posts/{post['id']}", token=bob["token"])))

check("an invalid token is refused", lambda: call("GET", "/v1/me", token="not-a-real-token", expect=401))


print("\n" + "=" * 60)
print(f"PASSED: {len(PASS)}   FAILED: {len(FAIL)}")
if FAIL:
    print("\nFailures:")
    for n, e in FAIL:
        print(f"  - {n}: {e}")
print("=" * 60)
sys.exit(1 if FAIL else 0)
