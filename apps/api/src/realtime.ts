import type { WebSocket } from "ws";
import type pg from "pg";

/**
 * Realtime hub.
 *
 * Realtime is a notification channel for committed changes; durable state still
 * lives in Postgres. Authorization is enforced by the caller before publishing,
 * and every subscriber is scoped to the circles (or conversations) they belong
 * to.
 *
 * Scaling. A single process is the default and is enough for a launch. The
 * in-memory subscriber set cannot be shared across containers, so room events
 * would only reach sockets in the same process. `PostgresBus` closes that gap:
 * when `REALTIME_BUS=postgres`, every publish is also written to `NOTIFY`, and
 * every instance relays what it receives. A room's members can then be spread
 * across many API containers and still all hear the event. The same seam takes
 * Redis later without touching the routes.
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

/** A cross-instance bus. `postgres` is the built-in implementation. */
export interface RealtimeBus {
  /** Send an already-serialized event to every other instance. */
  publish(scope: "room" | "circle" | "users", key: string, event: RealtimeEvent): void;
  /** Receive events from other instances. */
  onMessage(handler: (scope: "room" | "circle" | "users", key: string, event: RealtimeEvent) => void): void;
  close(): Promise<void>;
}

/**
 * Postgres LISTEN/NOTIFY bus.
 *
 * One dedicated connection LISTENs; publishes go out as `pg_notify`. The payload
 * is capped by Postgres (~8000 bytes), so a large payload is replaced with a
 * marker and the receiver refetches — which the client already does on every
 * event, since realtime only ever says "something changed".
 */
export class PostgresBus implements RealtimeBus {
  private handler: ((scope: "room" | "circle" | "users", key: string, event: RealtimeEvent) => void) | null = null;
  private closed = false;
  /** Identifies this instance so it can ignore its own NOTIFY echo. */
  private readonly origin = `inst_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  static readonly CHANNEL = "vibe_realtime";
  private static readonly MAX_PAYLOAD = 7000;

  constructor(private client: pg.PoolClient, private log?: { error: (obj: unknown, msg?: string) => void }) {
    void client.query(`LISTEN ${PostgresBus.CHANNEL}`);
    client.on("notification", (n) => {
      if (!n.payload || !this.handler) return;
      try {
        const parsed = JSON.parse(n.payload) as { scope: "room" | "circle" | "users"; key: string; event: RealtimeEvent; origin?: string };
        // Postgres delivers a NOTIFY to the connection that sent it too. Those
        // events were already delivered to local sockets by the publisher, so
        // relaying them again would double every message.
        if (parsed.origin === this.origin) return;
        this.handler(parsed.scope, parsed.key, parsed.event);
      } catch {
        /* ignore malformed bus frames */
      }
    });
    client.on("error", (err) => {
      this.log?.error({ err }, "realtime bus connection error");
    });
  }

  publish(scope: "room" | "circle" | "users", key: string, event: RealtimeEvent): void {
    if (this.closed) return;
    let payload = JSON.stringify({ scope, key, event, origin: this.origin });
    if (payload.length > PostgresBus.MAX_PAYLOAD) {
      // Too big for NOTIFY. The event type and entity still travel, which is all
      // a client needs to refetch.
      payload = JSON.stringify({ scope, key, event: { ...event, payload: { truncated: true } }, origin: this.origin });
    }
    void this.client.query(`SELECT pg_notify($1, $2)`, [PostgresBus.CHANNEL, payload]).catch(() => undefined);
  }

  onMessage(handler: (scope: "room" | "circle" | "users", key: string, event: RealtimeEvent) => void): void {
    this.handler = handler;
  }

  async close(): Promise<void> {
    this.closed = true;
    try {
      await this.client.query(`UNLISTEN ${PostgresBus.CHANNEL}`);
    } catch {
      /* connection may already be gone */
    }
  }
}

export class RealtimeHub {
  private subscribers = new Set<Subscriber>();
  private sequence = 0;

  constructor(private bus?: RealtimeBus, private maxSockets = 0) {
    // Relay bus messages that originated on another instance to local sockets.
    bus?.onMessage((scope, key, event) => {
      if (scope === "room") this.deliverToRoom(key, event);
      else if (scope === "circle") this.deliverToCircle(key, event);
      else this.deliverToUsers(key.split(","), event);
    });
  }

  /** True when the hub is at its configured socket ceiling. */
  atCapacity(): boolean {
    return this.maxSockets > 0 && this.subscribers.size >= this.maxSockets;
  }

  socketCount(): number {
    return this.subscribers.size;
  }

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
    const full = this.stamp(event);
    this.deliverToRoom(roomId, full, except);
    this.bus?.publish("room", roomId, full);
  }

  /** Publish to everyone who is a member of the given circle. */
  publishToCircle(circleId: string, event: Omit<RealtimeEvent, "id" | "sequence" | "timestamp">): void {
    const full = this.stamp(event);
    this.deliverToCircle(circleId, full);
    this.bus?.publish("circle", circleId, full);
  }

  /** Publish to a specific set of users (e.g. plan participants). */
  publishToUsers(userIds: string[], event: Omit<RealtimeEvent, "id" | "sequence" | "timestamp">): void {
    const full = this.stamp(event);
    this.deliverToUsers(userIds, full);
    this.bus?.publish("users", userIds.join(","), full);
  }

  private stamp(event: Omit<RealtimeEvent, "id" | "sequence" | "timestamp">): RealtimeEvent {
    this.sequence += 1;
    return { ...event, id: `evt_${this.sequence}`, sequence: this.sequence, timestamp: new Date().toISOString() };
  }

  private deliverToRoom(roomId: string, event: RealtimeEvent, except?: WebSocket): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.roomIds.has(roomId) && subscriber.socket !== except) this.send(subscriber, event);
    }
  }

  private deliverToCircle(circleId: string, event: RealtimeEvent): void {
    for (const subscriber of this.subscribers) {
      if (subscriber.circleIds.has(circleId)) this.send(subscriber, event);
    }
  }

  private deliverToUsers(userIds: string[], event: RealtimeEvent): void {
    const wanted = new Set(userIds);
    for (const subscriber of this.subscribers) {
      if (wanted.has(subscriber.userId)) this.send(subscriber, event);
    }
  }

  private send(subscriber: Subscriber, event: RealtimeEvent): void {
    if (subscriber.socket.readyState === subscriber.socket.OPEN) {
      subscriber.socket.send(JSON.stringify(event));
    }
  }
}
