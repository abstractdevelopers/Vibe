#!/usr/bin/env python3
"""
One real checkout against the live deployment, to prove the Bachs seam end to
end up to the point a human pays.

It registers two throwaway users, buys a paid gift, and prints the hosted
checkout URL Bachs returned. Nothing is charged: the money only moves when a
person completes the hosted page and Bachs sends a signed webhook back.

Usage: python3 scripts/live_checkout_probe.py [base_url]
"""
import json
import sys
import urllib.request
import uuid

BASE = (sys.argv[1] if len(sys.argv) > 1 else
        "https://4odwboyulnfdthdlv9hzrguf.172.104.128.165.sslip.io").rstrip("/")
TAG = uuid.uuid4().hex[:8]


def call(method, path, token=None, body=None, headers=None):
    data = json.dumps(body).encode() if body is not None else None
    h = {"content-type": "application/json"}
    if token:
        h["authorization"] = "Bearer " + token
    if headers:
        h.update(headers)
    req = urllib.request.Request(BASE + path, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return r.status, json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode() or "{}")


def register(role):
    code, r = call("POST", "/v1/auth/register", body={
        "email": f"live_{role}_{TAG}@example.com",
        "handle": f"live{role}{TAG}"[:20],
        "displayName": f"Live {role}",
        "password": "password123",
    })
    assert code == 201, (code, r)
    return r


provider = call("GET", "/health")[1].get("provider")
print(f"provider: {provider}")

buyer = register("buyer")
creator = register("creator")

code, purchase = call(
    "POST", "/v1/money/gifts/purchase", token=buyer["token"],
    headers={"idempotency-key": f"live-{TAG}"},
    body={"giftId": "rose", "quantity": 1, "recipientId": creator["user"]["id"]},
)
print(f"purchase: {code}")
print(json.dumps(purchase, indent=2))
if purchase.get("redirectUrl"):
    print("\nHosted checkout (open this and pay to complete the loop):")
    print("  " + purchase["redirectUrl"])
    print(f"\nreference: {purchase['reference']}")
    print("After paying, Bachs posts a signed webhook and the creator's balance updates.")
else:
    print("\nNo redirectUrl returned; check the provider configuration.")
    sys.exit(1)
