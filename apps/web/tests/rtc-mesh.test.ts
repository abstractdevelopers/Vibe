import { describe, expect, it } from "vitest";
import { peersToOfferTo } from "../src/rtc-mesh";

/**
 * A silent voice room is the worst failure this app can have: both people are
 * present, the UI says "Mic on", and nothing is heard. The cause was in who
 * offers to whom, so the rule is pinned here.
 */
describe("peers to offer to", () => {
  it("has exactly one offer per pair, decided by id order", () => {
    // The lower id offers, so only one side of each pair appears.
    expect(peersToOfferTo({ viewerId: "aaa", peerIds: ["bbb", "ccc"], layout: "open", isHost: false })).toEqual(["bbb", "ccc"]);
    expect(peersToOfferTo({ viewerId: "ccc", peerIds: ["aaa", "bbb"], layout: "open", isHost: false })).toEqual([]);
  });

  it("offers to a peer that joined after the viewer, whatever the id order", () => {
    // The bug: the viewer sorts below a peer that joined later, so the viewer
    // must offer. This is the case that used to leave the room silent.
    expect(peersToOfferTo({ viewerId: "aaa", peerIds: ["zzz"], layout: "open", isHost: false })).toEqual(["zzz"]);
  });

  it("never offers to itself", () => {
    expect(peersToOfferTo({ viewerId: "aaa", peerIds: ["aaa"], layout: "open", isHost: true })).toEqual([]);
  });

  it("lets a listener offer in a broadcast room, so it can hear the host", () => {
    // Only the host publishes, so the host does not offer downward; if the
    // listener did not offer either, the pair would never connect.
    expect(peersToOfferTo({ viewerId: "host", peerIds: ["l1", "zzz"], layout: "broadcast", isHost: true })).toEqual([]);
    expect(peersToOfferTo({ viewerId: "l1", peerIds: ["host"], layout: "broadcast", isHost: false })).toEqual(["host"]);
    expect(peersToOfferTo({ viewerId: "zzz", peerIds: ["host"], layout: "broadcast", isHost: false })).toEqual(["host"]);
  });

  it("connects a listener to every stage speaker, so an audience member can hear", () => {
    // An audience member is never on the stage themselves. They must still be
    // handed every speaker to connect to — the connection is what carries the
    // audio, and a listener publishes nothing.
    expect(peersToOfferTo({ viewerId: "aaa", peerIds: ["bbb", "ccc"], layout: "stage", isHost: false })).toEqual(["bbb", "ccc"]);
  });
});
