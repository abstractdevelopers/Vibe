import type { WebSocket } from "ws";

/**
 * In-process realtime hub. Realtime is a notification channel for committed
 * changes; durable state still lives in Postgres. Authorization is enforced by
 * the caller before publishing, and every subscriber is scoped to the circles
 * (or conversations) they belong to.
 */
export interface RealtimeEvent {
  id: string;
  type: string;
  entityId: string;
  sequence?: number;
  timestamp: string;
  payload: unknown;
}

interface Subscriber {
  socket: WebSocket;
  userId: string;
  circleIds: Set<string>;
  /** Rooms this socket is present in, so room events only reach the room. */
  roomIds: Set<string>;
}

export class RealtimeHub {
  private subscribers = new Set<Subscriber>();
  private sequence = 0;

  subscribe(socket: WebSocket, userId: string, circleIds: string[]): () => void {
    const subscriber: Subscriber = { socket, userId, circleIds: new Set(circleIds), roomIds: new Set() };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Track which room a socket is in. Presence is per connection. */
  joinRoom(socket: WebSocket, roomId: string): void {
    for (const s of this.subscribers) if (s.socket === socket) s.roomIds.add(roomId);
  }

  leaveRoom(socket: WebSocket, roomId: string): void {
    for (const s of this.subscribers) if (s.socket === socket) s.roomIds.delete(roomId);
  }

  /** Everyone currently present in a room. */
  roomMembers(roomId: string): Subscriber[] {
    return [...this.subscribers].filter((s) => s.roomIds.has(roomId));
  }

  /**
   * Publish a room event to every socket present in the room. `except` skips the
   * sender, which is what WebRTC signalling needs: an offer goes to the peer it
   * is meant for, not back to the sender.
   */
  publishToRoom(roomId: string, event: Omit<RealtimeEvent, "id" | "sequence" | "timestamp">, except?: WebSocket): void {
    this.sequence += 1;
    const full: RealtimeEvent = {
      ...event,
      id: `evt_${this.sequence}`,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
    };
    for (const subscriber of this.subscribers) {
      if (subscriber.roomIds.has(roomId) && subscriber.socket !== except) this.send(subscriber, full);
    }
  }

  private send(subscriber: Subscriber, event: RealtimeEvent): void {
    if (subscriber.socket.readyState === subscriber.socket.OPEN) {
      subscriber.socket.send(JSON.stringify(event));
    }
  }

  /** Publish to everyone who is a member of the given circle. */
  publishToCircle(circleId: string, event: Omit<RealtimeEvent, "id" | "sequence" | "timestamp">): void {
    this.sequence += 1;
    const full: RealtimeEvent = {
      ...event,
      id: `evt_${this.sequence}`,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
    };
    for (const subscriber of this.subscribers) {
      if (subscriber.circleIds.has(circleId)) this.send(subscriber, full);
    }
  }

  /** Publish to a specific set of users (e.g. plan participants). */
  publishToUsers(userIds: string[], event: Omit<RealtimeEvent, "id" | "sequence" | "timestamp">): void {
    const wanted = new Set(userIds);
    this.sequence += 1;
    const full: RealtimeEvent = {
      ...event,
      id: `evt_${this.sequence}`,
      sequence: this.sequence,
      timestamp: new Date().toISOString(),
    };
    for (const subscriber of this.subscribers) {
      if (wanted.has(subscriber.userId)) this.send(subscriber, full);
    }
  }
}
