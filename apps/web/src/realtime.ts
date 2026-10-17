import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "./api";

export interface RealtimeEvent {
  id: string;
  type: string;
  entityId: string;
  sequence?: number;
  timestamp: string;
  payload: unknown;
}

/**
 * Realtime notifications for committed changes.
 *
 * The server is authoritative; this channel only tells the client that
 * something changed so it can refetch. It reconnects with capped exponential
 * backoff, and the caller stays correct if the socket never connects because
 * every surface also loads over HTTP.
 */
export function useRealtime(onEvent: (event: RealtimeEvent) => void): void {
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    const token = getToken();
    if (!token) return;

    let socket: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let timer: number | undefined;

    const connect = () => {
      if (closed) return;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/v1/realtime?token=${encodeURIComponent(token)}`);

      socket.onopen = () => {
        retry = 0;
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as RealtimeEvent;
          if (parsed.type !== "realtime.ready") handler.current(parsed);
        } catch {
          /* ignore malformed frames */
        }
      };

      socket.onclose = (event) => {
        if (closed) return;
        // The server says why it closed. 4401 means the session is no longer
        // valid — reconnect would only be refused again, so stop. 4429 means
        // the instance is at its socket ceiling — back off longer and retry,
        // since a later connection may land on a less loaded instance.
        if (event.code === 4401) { closed = true; return; }
        const cap = event.code === 4429;
        // Backoff with jitter, capped, so a flaky network does not storm.
        const delay = Math.min(1000 * 2 ** retry, cap ? 60000 : 30000) + Math.random() * 500;
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      socket?.close();
    };
  }, []);
}

/**
 * A socket scoped to one live room.
 *
 * This is separate from `useRealtime`: it joins the room, delivers only that
 * room's events, and exposes `send` so the caller can relay WebRTC signalling.
 * The server still authorizes every durable write over HTTP; this channel only
 * carries presence, reactions, gifts and SDP/ICE.
 */
export function useRoomChannel(
  roomId: string | null,
  viewerId: string | null,
  onEvent: (event: RealtimeEvent) => void,
): { send: (msg: Record<string, unknown>) => void; status: "connecting" | "open" | "closed" } {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const viewerRef = useRef(viewerId);
  viewerRef.current = viewerId;
  const socketRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");

  useEffect(() => {
    if (!roomId) return;
    const token = getToken();
    if (!token) return;

    let socket: WebSocket | null = null;
    let retry = 0;
    let closed = false;
    let timer: number | undefined;

    const connect = () => {
      if (closed) return;
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${proto}://${location.host}/v1/realtime?token=${encodeURIComponent(token)}`);
      socketRef.current = socket;

      socket.onopen = () => {
        retry = 0;
        setStatus("open");
        socket?.send(JSON.stringify({ type: "room.join", roomId }));
      };

      socket.onmessage = (event) => {
        try {
          const parsed = JSON.parse(event.data) as RealtimeEvent & { payload?: { to?: string } };
          if (parsed.type === "realtime.ready") return;
          // RTC frames are addressed to one peer; ignore anyone else's.
          if (parsed.type.startsWith("rtc.") && parsed.payload?.to && parsed.payload.to !== viewerRef.current) return;
          handler.current(parsed);
        } catch {
          /* ignore malformed frames */
        }
      };

      socket.onclose = (event) => {
        setStatus("closed");
        if (closed) return;
        // A revoked session will never be accepted; stop rather than loop.
        if (event.code === 4401) { closed = true; return; }
        const delay = Math.min(1000 * 2 ** retry, event.code === 4429 ? 60000 : 30000) + Math.random() * 500;
        retry += 1;
        timer = window.setTimeout(connect, delay);
      };

      socket.onerror = () => socket?.close();
    };

    connect();

    return () => {
      closed = true;
      if (timer) window.clearTimeout(timer);
      try {
        socket?.send(JSON.stringify({ type: "room.leave", roomId }));
      } catch {
        /* socket already gone */
      }
      socket?.close();
      socketRef.current = null;
    };
  }, [roomId]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ roomId, ...msg }));
  }, [roomId]);

  return { send, status };
}
