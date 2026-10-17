import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, registerUser, resetDb, auth, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

// A 1x1 transparent PNG, small enough to inline.
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("media boundary", () => {
  it("stores an image and serves it back", async () => {
    const user = await registerUser(h.app, "pixel");
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: PNG },
    });
    expect(upload.statusCode).toBe(201);
    const { url } = upload.json();
    expect(url).toMatch(/^\/v1\/media\//);

    const fetched = await h.app.inject({ method: "GET", url });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toBe("image/png");
  });

  it("rejects a non-image data URL", async () => {
    const user = await registerUser(h.app, "nope");
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" },
    });
    expect(upload.statusCode).toBe(400);
  });

  it("stores a video, serves it with the right type, and marks it seekable", async () => {
    const user = await registerUser(h.app, "filmer");
    // A tiny but structurally valid MP4 header is not needed: the boundary
    // trusts the declared MIME type, as it does for images.
    const mp4 = "data:video/mp4;base64," + Buffer.from("fake-mp4-bytes-for-a-test").toString("base64");
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: mp4 },
    });
    expect(upload.statusCode).toBe(201);
    const { url, contentType } = upload.json();
    expect(contentType).toBe("video/mp4");
    expect(url).toMatch(/\.mp4$/);

    const fetched = await h.app.inject({ method: "GET", url });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.headers["content-type"]).toBe("video/mp4");
    expect(fetched.headers["accept-ranges"]).toBe("bytes");
  });

  it("rejects an unsupported video container", async () => {
    const user = await registerUser(h.app, "avi");
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: "data:video/x-msvideo;base64," + Buffer.from("nope").toString("base64") },
    });
    expect(upload.statusCode).toBe(400);
  });

  it("requires authentication", async () => {
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      payload: { dataUrl: PNG },
    });
    expect(upload.statusCode).toBe(401);
  });
});

describe("posts with media", () => {
  it("round-trips media URLs through the feed", async () => {
    const user = await registerUser(h.app, "sharer");
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: PNG },
    });
    const { url } = upload.json();

    const post = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(user.token),
      payload: { body: "Beach day", type: "image", mediaUrls: [url] },
    });
    expect(post.statusCode).toBe(201);

    const feed = await h.app.inject({ method: "GET", url: "/v1/feed", headers: auth(user.token) });
    const item = feed.json().items.find((p: { id: string }) => p.id === post.json().id);
    expect(item.mediaUrls).toEqual([url]);
  });

  it("refuses a post with no body and no media", async () => {
    const user = await registerUser(h.app, "empty");
    const post = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(user.token),
      payload: { type: "image" },
    });
    expect(post.statusCode).toBe(400);
  });

  it("refuses an executable URL", async () => {
    const user = await registerUser(h.app, "sneaky");
    const post = await h.app.inject({
      method: "POST",
      url: "/v1/posts",
      headers: auth(user.token),
      payload: { body: "hi", type: "image", mediaUrls: ["javascript:alert(1)"] },
    });
    expect(post.statusCode).toBe(422);
  });
});

describe("profile editing", () => {
  it("updates display name, bio and interests", async () => {
    const user = await registerUser(h.app, "editor");
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { displayName: "New Name", bio: "Hello", interests: ["food", "music"] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.displayName).toBe("New Name");
    expect(body.interests).toEqual(["food", "music"]);

    const me = await h.app.inject({ method: "GET", url: "/v1/me", headers: auth(user.token) });
    expect(me.json().displayName).toBe("New Name");
  });

  it("rejects a handle already taken by someone else", async () => {
    await registerUser(h.app, "taken");
    const user = await registerUser(h.app, "wants");
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { handle: "taken" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("discovery ranking", () => {
  it("ranks a same-area, interest-matching place above an unrelated one", async () => {
    const user = await registerUser(h.app, "explorer");
    await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { city: "Lagos", area: "Lekki", interests: ["culture"] },
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/explore?limit=50",
      headers: auth(user.token),
    });
    const results = res.json().results as Array<{ name: string; score: number; reasons: string[] }>;
    const gallery = results.find((r) => r.name === "Nike Art Gallery");
    const mall = results.find((r) => r.name === "The Palms Mall");

    expect(gallery).toBeDefined();
    expect(mall).toBeDefined();
    // Both are in Lekki; the gallery also matches the "culture" interest.
    expect(gallery!.score).toBeGreaterThan(mall!.score);
    expect(gallery!.reasons).toContain("matches your interests");
  });

  it("filters by city", async () => {
    const user = await registerUser(h.app, "abuja");
    const res = await h.app.inject({
      method: "GET",
      url: "/v1/explore?city=Abuja",
      headers: auth(user.token),
    });
    const results = res.json().results as Array<{ city: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.city === "Abuja")).toBe(true);
  });

  it("surfaces a discoverable plan as an event", async () => {
    const host = await registerUser(h.app, "host");
    const circle = (
      await h.app.inject({
        method: "POST",
        url: "/v1/circles",
        headers: auth(host.token),
        payload: { name: "Crew", privacy: "public_discoverable" },
      })
    ).json();

    await h.app.inject({
      method: "POST",
      url: "/v1/plans",
      headers: auth(host.token),
      payload: {
        circleId: circle.id,
        title: "Rooftop hangout",
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        city: "Lagos",
        area: "Victoria Island",
        discoverable: true,
      },
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/explore?city=Lagos&kind=event",
      headers: auth(host.token),
    });
    const results = res.json().results as Array<{ name: string; kind: string }>;
    expect(results.some((r) => r.kind === "event" && r.name === "Rooftop hangout")).toBe(true);
  });

  it("does not surface a non-discoverable plan", async () => {
    const host = await registerUser(h.app, "privatehost");
    const circle = (
      await h.app.inject({
        method: "POST",
        url: "/v1/circles",
        headers: auth(host.token),
        payload: { name: "Secret", privacy: "private" },
      })
    ).json();

    await h.app.inject({
      method: "POST",
      url: "/v1/plans",
      headers: auth(host.token),
      payload: {
        circleId: circle.id,
        title: "Hidden dinner",
        startsAt: new Date(Date.now() + 86400000).toISOString(),
        city: "Lagos",
        discoverable: false,
      },
    });

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/explore?kind=event",
      headers: auth(host.token),
    });
    const results = res.json().results as Array<{ name: string }>;
    expect(results.some((r) => r.name === "Hidden dinner")).toBe(false);
  });

  it("surfaces a published Vibe event in Explore with a location reason", async () => {
    const host = await registerUser(h.app, "eventhost");
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth(host.token),
      payload: {
        title: "Beach cleanup",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        timezone: "Africa/Lagos",
        city: "Lagos",
        area: "Lekki",
        priceMinor: 0,
        currency: "NGN",
      },
    });
    const id = created.json().id;
    await h.app.inject({ method: "POST", url: `/v1/events/${id}/publish`, headers: auth(host.token) });

    const res = await h.app.inject({
      method: "GET",
      url: "/v1/explore?city=Lagos&area=Lekki&kind=event",
      headers: auth(host.token),
    });
    const results = res.json().results as Array<{ name: string; vibeEvent?: boolean; reasons: string[] }>;
    const event = results.find((r) => r.name === "Beach cleanup");
    expect(event).toBeDefined();
    expect(event!.vibeEvent).toBe(true);
    expect(event!.reasons).toContain("in your area");
  });

  it("does not surface a draft Vibe event in Explore", async () => {
    const host = await registerUser(h.app, "drafthost");
    await h.app.inject({
      method: "POST",
      url: "/v1/events",
      headers: auth(host.token),
      payload: {
        title: "Unfinished idea",
        startsAt: new Date(Date.now() + 86_400_000).toISOString(),
        timezone: "Africa/Lagos",
        city: "Lagos",
      },
    });
    const res = await h.app.inject({ method: "GET", url: "/v1/explore?kind=event", headers: auth(host.token) });
    const results = res.json().results as Array<{ name: string }>;
    expect(results.some((r) => r.name === "Unfinished idea")).toBe(false);
  });
});
