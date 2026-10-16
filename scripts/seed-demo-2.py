#!/usr/bin/env python3
"""Seed rich demo data covering every surface for visual QA."""
import json, urllib.request, urllib.error, datetime

API = "http://localhost:12000"

def call(path, body=None, token=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("content-type", "application/json")
    if method == "POST" or (data and method is None):
        import uuid as _u; req.add_header("idempotency-key", "seed-" + _u.uuid4().hex)
    if token:
        req.add_header("authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            return r.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return e.code, (json.loads(raw) if raw else None)

def ensure(email, handle, name):
    st, res = call("/v1/auth/register", {"email": email, "handle": handle, "displayName": name, "password": "password123"})
    if st == 201:
        return res["token"], res["user"]["id"]
    st, res = call("/v1/auth/login", {"email": email, "password": "password123"})
    if st == 200:
        return res["token"], res["user"]["id"]
    raise SystemExit(f"auth fail {email}: {st} {res}")

zara_t, zara = ensure("zara@example.com", "zara", "Zara Ade")
ada_t, ada = ensure("ada@example.com", "ada", "Ada Okafor")
tunde_t, tunde = ensure("tunde@example.com", "tunde", "Tunde Bello")

call("/v1/follows", {"followeeId": ada}, zara_t)
call("/v1/follows", {"followeeId": tunde}, zara_t)

# posts
_, p1 = call("/v1/posts", {"body": "Golden hour at Tarkwa Bay. Who's coming next weekend?", "audience": "public"}, ada_t)
_, p2 = call("/v1/posts", {"body": "Anyone up for a board-game night on Friday?", "audience": "public"}, tunde_t)
if p1:
    call(f"/v1/posts/{p1['id']}/reactions", {"kind": "like"}, zara_t)
    call(f"/v1/posts/{p1['id']}/comments", {"body": "I'm in — bring the paddleboard."}, zara_t)
    call(f"/v1/posts/{p1['id']}/gifts", {"kind": "spark", "note": "Great shot"}, zara_t)

# circle
st, circle = call("/v1/circles", {"name": "Weekend Crew", "description": "Plans for the weekend", "privacy": "private"}, zara_t)
cid = circle["id"] if st in (200, 201) and circle else None
if cid:
    # members join through the invite flow (direct add is owner-only in some paths)
    st, inv = call(f"/v1/circles/{cid}/invites", {"role": "member"}, zara_t)
    tok = inv.get("inviteToken") if inv else None
    if tok:
        call(f"/v1/invites/{tok}/accept", {}, ada_t)
        call(f"/v1/invites/{tok}/accept", {}, tunde_t)
    # plan
    when = (datetime.datetime.utcnow() + datetime.timedelta(days=5)).replace(microsecond=0).isoformat() + "Z"
    st, plan = call("/v1/plans", {"circleId": cid, "title": "Beach day at Tarkwa Bay", "description": "Boat over at 10am, bring snacks.", "startsAt": when, "timezone": "Africa/Lagos", "place": "Tarkwa Bay", "budgetAmount": 1200000, "budgetCurrency": "NGN", "city": "Lagos", "area": "Lagos Island"}, zara_t)
    print("plan", st)
    if st in (200, 201) and plan:
        call(f"/v1/plans/{plan['id']}/rsvps", {"state": "going"}, ada_t)
        call(f"/v1/plans/{plan['id']}/rsvps", {"state": "interested"}, tunde_t)
    # poll
    st, poll = call("/v1/activities", {"question": "Beach or board games?", "options": ["Beach", "Board games", "Both"], "circleId": cid}, zara_t)
    print("poll", st)
    if st in (200, 201) and poll:
        opts = poll.get("options") or poll.get("activity", {}).get("options") or []
        if opts:
            call(f"/v1/activities/{poll.get('id', poll.get('activity',{}).get('id'))}/votes", {"optionId": opts[0]["id"]}, ada_t)
    # expense
    st, exp = call("/v1/expenses", {"circleId": cid, "description": "Boat ride", "amountMinor": 2400000, "currency": "NGN", "payerId": zara, "splitMode": "equal", "participants": [{"userId": zara}, {"userId": ada}, {"userId": tunde}]}, zara_t)
    print("expense", st)
    if st in (200, 201) and exp:
        eid = exp.get("id", exp.get("expense", {}).get("id"))
        call(f"/v1/expenses/{eid}/payment-reports", {"note": "Sent via transfer"}, ada_t)

# DM conversation
st, conv = call("/v1/conversations", {"userId": ada}, zara_t)
print("conversation", st)
if st in (200, 201) and conv:
    convid = conv.get("id", conv.get("conversation", {}).get("id"))
    call(f"/v1/conversations/{convid}/messages", {"body": "Are we still on for Saturday?", "clientId": "seed-1"}, zara_t)
    call(f"/v1/conversations/{convid}/messages", {"body": "Yes! I'll bring the cooler.", "clientId": "seed-2"}, ada_t)
    call(f"/v1/conversations/{convid}/messages", {"body": "Perfect. I'll get the tickets tonight.", "clientId": "seed-3"}, zara_t)

print("seed2 complete", {"circle": cid})
