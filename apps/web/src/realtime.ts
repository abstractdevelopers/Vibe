import { useEffect, useRef } from "react";
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

      socket.onclose = () => {
        if (closed) return;
        // Backoff with jitter, capped, so a flaky network does not storm.
        const delay = Math.min(1000 * 2 ** retry, 30000) + Math.random() * 500;
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
