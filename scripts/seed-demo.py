#!/usr/bin/env python3
"""Seed demo data for manual/visual QA. Idempotent-ish: registers users if absent."""
import json, urllib.request, urllib.error

API = "http://localhost:12000"

def call(path, body=None, token=None, method=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method or ("POST" if data else "GET"))
    req.add_header("content-type", "application/json")
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
    raise SystemExit(f"could not auth {email}: {st} {res}")

zara_t, zara_id = ensure("zara@example.com", "zara", "Zara Ade")
ada_t, ada_id = ensure("ada@example.com", "ada", "Ada Okafor")
tunde_t, tunde_id = ensure("tunde@example.com", "tunde", "Tunde Bello")

# follow
call("/v1/follows", {"followeeId": ada_id}, zara_t)
call("/v1/follows", {"followeeId": tunde_id}, zara_t)

# a circle
st, circle = call("/v1/circles", {"name": "Weekend Crew", "description": "Plans for the weekend", "privacy": "private"}, zara_t)
print("circle", st)
if st in (200, 201) and circle:
    cid = circle.get("id")
    for tid in (ada_id, tunde_id):
        call(f"/v1/circles/{cid}/members", {"userId": tid}, zara_t)

# posts
call("/v1/posts", {"body": "Golden hour at Tarkwa Bay. Who's coming next weekend?", "audience": "public"}, ada_t)
call("/v1/posts", {"body": "Anyone up for a board-game night on Friday?", "audience": "public"}, tunde_t)

print("seed complete")
