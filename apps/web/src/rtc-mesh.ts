/**
 * Who a speaker offers to, given the room format.
 *
 * A mesh call must have exactly one offer per pair. If both sides offer, the
 * two peer connections glare and the call can stall; if neither offers, the
 * call is silent. The tie-break is the id order — the lower id offers — which is
 * stable and needs no extra round trip.
 *
 * The earlier version only consulted this when a mic was toggled, so a peer that
 * joined later never triggered an offer and the room stayed silent. It is a pure
 * function so the rule can be tested without a browser or a peer connection.
 */
export function peersToOfferTo(opts: {
  viewerId: string;
  peerIds: string[];
  layout: string | null | undefined;
  isHost: boolean;
}): string[] {
  const { viewerId, peerIds, layout, isHost } = opts;
  const others = peerIds.filter((id) => id !== viewerId);
  if (layout === "broadcast") {
    // Only the host publishes; a listener answers the host's offer instead.
    return isHost ? others : [];
  }
  return others.filter((id) => viewerId < id);
}
