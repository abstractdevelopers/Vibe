import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { auth, createHarness, registerUser, resetDb, type Harness } from "./helpers.js";

let h: Harness;

beforeEach(async () => {
  if (!h) h = await createHarness();
  await resetDb(h.pool);
});

afterAll(async () => {
  if (h) await h.close();
});

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("profile avatar", () => {
  it("stores an uploaded avatar and returns it on the profile", async () => {
    const user = await registerUser(h.app, "avatar");

    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: PNG },
    });
    expect(upload.statusCode).toBe(201);
    const { url } = upload.json();

    const patch = await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { avatarUrl: url },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().avatarUrl).toBe(url);

    const me = await h.app.inject({ method: "GET", url: "/v1/me", headers: auth(user.token) });
    expect(me.json().avatarUrl).toBe(url);

    const profile = await h.app.inject({ method: "GET", url: `/v1/users/${user.id}`, headers: auth(user.token) });
    expect(profile.json().avatarUrl).toBe(url);
  });

  it("clears the avatar when set to null", async () => {
    const user = await registerUser(h.app, "clearer");
    const upload = await h.app.inject({
      method: "POST",
      url: "/v1/media",
      headers: auth(user.token),
      payload: { dataUrl: PNG },
    });
    await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { avatarUrl: upload.json().url },
    });
    const cleared = await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { avatarUrl: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().avatarUrl).toBeNull();
  });

  it("rejects an avatar that is not an image URL or media path", async () => {
    const user = await registerUser(h.app, "badactor");
    const res = await h.app.inject({
      method: "PATCH",
      url: "/v1/me",
      headers: auth(user.token),
      payload: { avatarUrl: "javascript:alert(1)" },
    });
    expect(res.statusCode).toBe(422);
  });
});
