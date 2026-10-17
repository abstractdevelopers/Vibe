import { describe, expect, it } from "vitest";
import { baseForRoom, themeForRoom } from "../src/themes";

/**
 * Room kinds the API accepts are `voice`, `listen`, `music`, `movie`, `sports`
 * and `other`. The catalogue's base palettes are named `voice`, `listen`,
 * `music`, `watch`, `sports` — so `movie` had no palette of its own and `other`
 * had none at all, and both fell through to the voice lounge regardless of what
 * the room actually was.
 */

const ROOM_KINDS = ["voice", "listen", "music", "movie", "sports", "other"];

describe("room theme resolution", () => {
  it("gives a watch party the watch-party palette", () => {
    expect(baseForRoom("movie")).toBe("watch");
    expect(themeForRoom("movie").id).toBe("watch-classic");
  });

  it("gives a plain gathering the voice lounge rather than a random palette", () => {
    expect(baseForRoom("other")).toBe("voice");
  });

  it("keeps each room kind in the rooms family", () => {
    for (const kind of ROOM_KINDS) {
      expect(themeForRoom(kind).family, `${kind} is not a room theme`).toBe("rooms");
    }
  });

  it("does not collapse movie and voice onto the same palette", () => {
    expect(themeForRoom("movie").id).not.toBe(themeForRoom("voice").id);
  });
});
