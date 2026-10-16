import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHarness, resetDb, registerUser, auth, type Harness, type TestUser } from "./helpers.js";

/**
 * A malformed id in a path must be a 404, not a 500.
 *
 * Routes take `:id` straight from the URL and hand it to Postgres. A non-UUID
 * reaches the database, which rejects it with SQLSTATE 22P02 ("invalid input
 * syntax for type uuid"). Before the central handler mapped that to a 404, every
 * such request returned a 500 "Something went wrong" — a client mistake
 * reported as a server fault, and a log full of noise on launch day.
 */
describe("malformed ids in paths", () => {
  let h: Harness;
  let user: TestUser;

  beforeAll(async () => {
    h = await createHarness();
    await resetDb(h.pool);
    user = await registerUser(h.app, "uuidcheck");
  });
  afterAll(async () => h.close());

  it("returns 404 for a non-UUID user id", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/users/not-a-uuid", headers: auth(user.token) });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("returns 404 for a non-UUID post id", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/posts/not-a-uuid/comments", headers: auth(user.token) });
    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for a non-UUID merchant id", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/merchants/not-a-uuid", headers: auth(user.token) });
    expect(res.statusCode).toBe(404);
  });

  it("still returns 404 for a well-formed but absent id", async () => {
    const res = await h.app.inject({
      method: "GET", url: "/v1/users/00000000-0000-0000-0000-000000000000", headers: auth(user.token),
    });
    expect(res.statusCode).toBe(404);
  });

  it("does not leak the database error", async () => {
    const res = await h.app.inject({ method: "GET", url: "/v1/users/not-a-uuid", headers: auth(user.token) });
    expect(JSON.stringify(res.json())).not.toContain("invalid input syntax");
  });
});
