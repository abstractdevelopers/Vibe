/**
 * Who offers to whom, given the room format and who is listening or speaking.
 *
 * A mesh call must have exactly one offer per pair. If both sides offer, the
 * two peer connections glare and the call can stall; if neither offers, the
 * call is silent. The tie-break is the id order — the lower id offers — which is
 * stable and needs no extra round trip.
 *
 * Two rules matter beyond the tie-break:
 *
 *  - A *listener* must connect to the speakers even though they publish
 *    nothing. Their connection is receive-only, but it is what carries the
 *    audio. The offer therefore belongs to whoever wants the media, not to
 *    whoever produces it. The earlier version was only consulted while a mic
 *    was on, so an audience member never created a connection and heard
 *    nothing at all.
 *  - In a broadcast room only the host publishes, so the listener offers and
 *    the host answers. Nobody connects to a peer that publishes nothing.
 *
 * It is a pure function so the rule can be tested without a browser or a peer
 * connection.
 */
export function peersToOfferTo(opts: {
  viewerId: string;
  /** Peers the viewer should hear: the stage speakers, or the host. */
  peerIds: string[];
  layout: string | null | undefined;
  isHost: boolean;
}): string[] {
  const { viewerId, peerIds, layout, isHost } = opts;
  const others = peerIds.filter((id) => id !== viewerId);
  if (layout === "broadcast") {
    // The host publishes; each listener pulls from the host. The host never
    // offers downward, so there is no glare and no wasted connection.
    return isHost ? [] : others;
  }
  return others.filter((id) => viewerId < id);
}
