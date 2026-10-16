import { createContext, useContext } from "react";

/**
 * Minimal navigation. The app has five tabs plus a small stack of detail views
 * (a profile, a plan, an expense breakdown, the inbox). This is deliberately not
 * a router: every route is in-memory and the detail views take an id, which is
 * all the first sprint needs. Swap for a real router when deep links matter.
 */
export type Route =
  | { name: "tabs" }
  | { name: "inbox" }
  | { name: "profile"; userId: string }
  | { name: "plan"; planId: string }
  | { name: "expense"; expenseId: string }
  | { name: "edit-profile" }
  | { name: "settings" }
  | { name: "place"; placeId: string }
  | { name: "messages" }
  | { name: "conversation"; conversationId: string }
  | { name: "circle"; circleId: string }
  | { name: "store"; merchantId: string }
  | { name: "product"; productId: string }
  | { name: "orders" }
  | { name: "order"; orderId: string }
  | { name: "advertising" }
  | { name: "events" }
  | { name: "event"; eventId: string }
  | { name: "pass" }
  | { name: "admin" }
  | { name: "assist" }
  | { name: "merchant"; merchantId: string }
  | { name: "live" }
  | { name: "room"; roomId: string };

export interface Navigation {
  route: Route;
  push: (route: Exclude<Route, { name: "tabs" }>) => void;
  back: () => void;
}

export const NavContext = createContext<Navigation | null>(null);
export function useNav(): Navigation {
  const nav = useContext(NavContext);
  if (!nav) throw new Error("useNav must be used inside NavContext");
  return nav;
}
