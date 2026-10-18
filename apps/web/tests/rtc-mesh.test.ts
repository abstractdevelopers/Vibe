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

  it("lets only the host offer in a broadcast room", () => {
    expect(peersToOfferTo({ viewerId: "host", peerIds: ["l1", "l2"], layout: "broadcast", isHost: true })).toEqual(["l1", "l2"]);
    // A listener answers, it does not offer.
    expect(peersToOfferTo({ viewerId: "l1", peerIds: ["host"], layout: "broadcast", isHost: false })).toEqual([]);
  });
});
