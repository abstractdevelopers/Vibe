import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import { AuthScreen } from "./screens/Auth";
import { HomeScreen, type CreateMode } from "./screens/Home";
import { CirclesScreen } from "./screens/Circles";
import { CircleDetailScreen } from "./screens/CircleDetail";
import { ExploreScreen } from "./screens/Explore";
import { YouScreen } from "./screens/You";
import { InboxScreen } from "./screens/Inbox";
import { ProfileScreen } from "./screens/Profile";
import { PlanDetailScreen } from "./screens/PlanDetail";
import { ExpenseDetailScreen } from "./screens/ExpenseDetail";
import { EditProfileScreen } from "./screens/EditProfile";
import { SettingsScreen } from "./screens/Settings";
import { PlaceDetailScreen } from "./screens/PlaceDetail";
import { MessagesScreen } from "./screens/Messages";
import { ConversationScreen } from "./screens/Conversation";
import { StorefrontScreen, ProductScreen, OrdersScreen, OrderScreen } from "./screens/Commerce";
import { AdvertisingScreen } from "./screens/Advertising";
import { EventsScreen } from "./screens/Events";
import { LiveScreen, RoomScreen } from "./screens/Live";
import { PassScreen } from "./screens/Pass";
import { AdminScreen } from "./screens/Admin";
import { Wallet } from "./screens/Wallet";
import { AssistScreen } from "./screens/Assist";
import { CreateSheet } from "./components/CreateSheet";
import { CreateSomethingSheet } from "./components/CreateSomething";
import {
  ChatIcon,
  CirclesIcon,
  CompassIcon,
  EditIcon,
  HomeIcon,
  InboxIcon,
  LogOutIcon,
  MegaphoneIcon,
  PassIcon,
  PlusIcon,
  ReceiptIcon,
  SettingsIcon,
  SparklesIcon,
  WalletIcon,
  ShieldIcon,
  TicketIcon,
  RadioIcon,
  UserIcon,
} from "./components/Icons";
import { NavContext, useNav, type Route } from "./nav";
import { useRealtime } from "./realtime";
import { Avatar } from "./components/Avatar";
import type { Me } from "./types";

export type Tab = "home" | "circles" | "explore" | "you";

/**
 * The app routes in memory, so a shared link cannot reach a screen on its own.
 * We read the token out of `/invite/<token>` (or `?invite=`) at boot, keep it,
 * and act on it once we know whether the visitor is signed in. The token is
 * stripped from the address bar so a refresh does not re-trigger it.
 */
function readInviteToken(): string | null {
  const fromQuery = new URLSearchParams(window.location.search).get("invite");
  const pathMatch = window.location.pathname.match(/\/invite\/([A-Za-z0-9_-]+)/);
  return fromQuery ?? pathMatch?.[1] ?? null;
}

export function App() {
  const [inviteToken, setInviteToken] = useState<string | null>(() => readInviteToken());
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("home");
  const [route, setRoute] = useState<Route>({ name: "tabs" });
  const [routeStack, setRouteStack] = useState<Route[]>([]);
  const [unread, setUnread] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("post");
  const [startOpen, setStartOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const openCreate = (mode: CreateMode) => {
    setCreateMode(mode);
    setCreateOpen(true);
  };

  const loadMe = useCallback(async () => {
    if (!getToken()) {
      setMe(null);
      setChecking(false);
      return;
    }
    try {
      const result = await api<Me>("/v1/me");
      setMe(result);
      const counts = await api<{ unread: number }>("/v1/notifications/unread-count");
      const msgs = await api<{ unread: number }>("/v1/messaging/unread-count");
      setUnread(counts.unread + msgs.unread);
    } catch {
      setToken(null);
      setMe(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  // Strip the token from the URL once captured, so Back/refresh is clean.
  useEffect(() => {
    if (readInviteToken() && window.history.replaceState) {
      window.history.replaceState(null, "", window.location.pathname.replace(/\/invite\/[A-Za-z0-9_-]+/, "/"));
    }
  }, []);

  const acceptInvite = useCallback(async (token: string) => {
    setInviteBusy(true);
    setInviteError(null);
    try {
      const result = await api<{ circleId: string }>(`/v1/invites/${token}/accept`, {
        method: "POST",
        idempotencyKey: `invite-${token}`,
      });
      setInviteToken(null);
      setTab("circles");
      setRouteStack([]);
      setRoute({ name: "circle", circleId: result.circleId });
    } catch (err) {
      setInviteError(err instanceof ApiError ? err.message : "Could not join that Circle");
    } finally {
      setInviteBusy(false);
    }
  }, []);

  // A signed-in visitor holding an invite joins immediately.
  useEffect(() => {
    if (me && inviteToken) void acceptInvite(inviteToken);
  }, [me, inviteToken, acceptInvite]);

  // A committed change elsewhere refreshes what this client is looking at.
  useRealtime(() => {
    setRefreshKey((k) => k + 1);
    void Promise.all([
      api<{ unread: number }>("/v1/notifications/unread-count"),
      api<{ unread: number }>("/v1/messaging/unread-count"),
    ])
      .then(([n, m]) => setUnread(n.unread + m.unread))
      .catch(() => undefined);
  });

  useEffect(() => {
    const saved = localStorage.getItem("vibe.theme");
    if (saved) document.documentElement.dataset.theme = saved;
  }, []);

  const bump = () => setRefreshKey((k) => k + 1);
  // Detail views form a real stack, so Back returns to the screen you came from
  // (a plan returns to its Circle, not straight to the tab).
  const push = (next: Exclude<Route, { name: "tabs" }>) => {
    setRouteStack((stack) => [...stack, route]);
    setRoute(next);
  };
  const back = () => {
    setRouteStack((stack) => {
      if (stack.length === 0) {
        setRoute({ name: "tabs" });
        return stack;
      }
      setRoute(stack[stack.length - 1]!);
      return stack.slice(0, -1);
    });
  };
  // A tab tap always clears the detail stack and returns to the tab shell.
  const goToTabs = () => {
    setRouteStack([]);
    setRoute({ name: "tabs" });
  };

  return (
    <NavContext.Provider value={{ route, push, back }}>
      <div className="atmosphere" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />

      {checking && (
        <div className="app-shell">
          <div className="skeleton" aria-label="Loading Vibe" />
          <div className="skeleton" />
        </div>
      )}

      {!checking && !me && (
        <>
          {inviteToken && <InviteLanding token={inviteToken} />}
          <AuthScreen
            onAuthenticated={async () => {
              setChecking(true);
              await loadMe();
            }}
          />
        </>
      )}

      {!checking && me && (
        <>
          <header className="topbar">
            <span className="wordmark">
              Vibe<span className="dot" aria-hidden="true" />
            </span>
            <div className="row" style={{ gap: "var(--space-1)" }}>
              <button
                className="icon-button"
                aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
                onClick={() => push({ name: "inbox" })}
              >
                <InboxIcon width={20} height={20} />
                {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
              </button>
              <button className="icon-button" aria-label="Messages" onClick={() => push({ name: "messages" })}>
                <ChatIcon width={20} height={20} />
              </button>
              <AccountMenu
                me={me}
                onMeChanged={loadMe}
                onOpenProfile={() => push({ name: "profile", userId: me.id })}
                onStartSomething={() => setStartOpen(true)}
              />
            </div>
          </header>

          {inviteError && (
            <div className="notice danger" style={{ margin: "0 var(--space-4) var(--space-2)" }} role="alert">
              {inviteError}
            </div>
          )}
          {inviteBusy && <div className="notice" style={{ margin: "0 var(--space-4) var(--space-2)" }}>Joining the Circle…</div>}

          <main className="app-shell">
            {route.name === "tabs" && (
              <>
                {tab === "home" && (
                  <HomeScreen
                    me={me}
                    refreshKey={refreshKey}
                    onChanged={bump}
                    onCreate={(mode) => openCreate(mode)}
                  />
                )}
                {tab === "circles" && <CirclesScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
                {tab === "explore" && <ExploreScreen me={me} />}
                {tab === "you" && <YouScreen me={me} onMeChanged={loadMe} />}
              </>
            )}
            {route.name === "inbox" && <InboxScreen refreshKey={refreshKey} onChanged={bump} />}
            {route.name === "profile" && <ProfileScreen userId={route.userId} me={me} onChanged={bump} />}
            {route.name === "circle" && (
              <CircleDetailScreen
                circleId={route.circleId}
                refreshKey={refreshKey}
                onBack={back}
                onChanged={bump}
              />
            )}
            {route.name === "plan" && (
              <PlanDetailScreen planId={route.planId} me={me} onBack={back} onChanged={bump} />
            )}
            {route.name === "expense" && (
              <ExpenseDetailScreen expenseId={route.expenseId} me={me} onBack={back} onChanged={bump} />
            )}
            {route.name === "edit-profile" && (
              <EditProfileScreen me={me} onBack={back} onSaved={loadMe} />
            )}
            {route.name === "settings" && <SettingsScreen me={me} onBack={back} onMeChanged={loadMe} />}
            {route.name === "place" && <PlaceDetailScreen placeId={route.placeId} onBack={back} />}
            {route.name === "messages" && <MessagesScreen me={me} refreshKey={refreshKey} />}
            {route.name === "conversation" && (
              <ConversationScreen conversationId={route.conversationId} me={me} onChanged={bump} />
            )}
            {route.name === "store" && <StorefrontScreen merchantId={route.merchantId} onBack={back} />}
            {route.name === "product" && <ProductScreen productId={route.productId} onBack={back} />}
            {route.name === "orders" && <OrdersScreen onBack={back} />}
            {route.name === "order" && <OrderScreen orderId={route.orderId} onBack={back} />}
            {route.name === "advertising" && <AdvertisingScreen onBack={back} />}
            {route.name === "events" && <EventsScreen onBack={back} />}
            {route.name === "live" && <LiveScreen onBack={back} />}
            {route.name === "room" && <RoomScreen roomId={route.roomId} onBack={back} />}
            {route.name === "pass" && <PassScreen onBack={back} />}
            {route.name === "admin" && <AdminScreen onBack={back} />}
            {route.name === "wallet" && <Wallet onClose={back} />}
            {route.name === "assist" && <AssistScreen onBack={back} />}
          </main>

          <nav className="bottom-nav" aria-label="Primary">
            <NavButton id="home" label="Home" Icon={HomeIcon} tab={tab} setTab={setTab} route={route} onNavigate={goToTabs} />
            <NavButton id="circles" label="Circles" Icon={CirclesIcon} tab={tab} setTab={setTab} route={route} onNavigate={goToTabs} />
            <button className="create" aria-label="Create" onClick={() => openCreate("post")}>
              <span>
                <PlusIcon width={22} height={22} />
              </span>
            </button>
            <NavButton id="explore" label="Explore" Icon={CompassIcon} tab={tab} setTab={setTab} route={route} onNavigate={goToTabs} />
            <NavButton id="you" label="You" Icon={UserIcon} tab={tab} setTab={setTab} route={route} onNavigate={goToTabs} />
          </nav>
        </>
      )}

      {startOpen && me && (
        <CreateSomethingSheet
          onClose={() => setStartOpen(false)}
          onCreated={() => {
            setStartOpen(false);
            setRoute({ name: "tabs" });
            setTab("explore");
            bump();
          }}
        />
      )}

      {createOpen && me && (
        <CreateSheet
          me={me}
          initialMode={createMode}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setRoute({ name: "tabs" });
            setTab("home");
            bump();
          }}
        />
      )}
    </NavContext.Provider>
  );
}

function NavButton({
  id,
  label,
  Icon,
  tab,
  setTab,
  route,
  onNavigate,
}: {
  id: Tab;
  label: string;
  Icon: typeof HomeIcon;
  tab: Tab;
  setTab: (t: Tab) => void;
  route: Route;
  onNavigate: () => void;
}) {
  const active = route.name === "tabs" && tab === id;
  return (
    <button
      aria-current={active ? "page" : undefined}
      onClick={() => {
        setTab(id);
        // A tab tap always returns to the tab shell from any detail view.
        if (route.name !== "tabs") onNavigate();
      }}
    >
      <Icon />
      {label}
    </button>
  );
}

export { ApiError };

/**
 * Top-bar account menu. Logout lives here as well as in You, because the spec
 * requires a reachable sign-out and a user should never have to hunt for it.
 */
function AccountMenu({
  me,
  onMeChanged,
  onOpenProfile,
  onStartSomething,
}: {
  me: Me;
  onMeChanged: () => void | Promise<void>;
  onOpenProfile: () => void;
  onStartSomething: () => void;
}) {
  const nav = useNav();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDoc(event: MouseEvent) {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function logout() {
    try {
      await api("/v1/auth/logout", { method: "POST" });
    } finally {
      setToken(null);
      window.location.reload();
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="avatar-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        <Avatar name={me.displayName} url={me.avatarUrl} size="sm" />
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <div style={{ fontWeight: 700 }}>{me.displayName}</div>
            <div className="meta">@{me.handle}</div>
          </div>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenProfile();
            }}
          >
            <UserIcon width={17} height={17} /> View profile
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "edit-profile" });
            }}
          >
            <EditIcon width={17} height={17} /> Edit profile
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onStartSomething();
            }}
          >
            <PlusIcon width={17} height={17} /> Start something
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "events" });
            }}
          >
            <TicketIcon width={17} height={17} /> Events
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "live" });
            }}
          >
            <RadioIcon width={17} height={17} /> Live Now
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "pass" });
            }}
          >
            <PassIcon width={17} height={17} /> Vibe Pass
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "assist" });
            }}
          >
            <SparklesIcon width={17} height={17} /> Assist
          </button>
          {me.isAdmin && (
            <button
              className="menu-item"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                nav.push({ name: "admin" });
              }}
            >
              <ShieldIcon width={17} height={17} /> Operator console
            </button>
          )}
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "wallet" });
            }}
          >
            <WalletIcon width={17} height={17} /> Wallet
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "orders" });
            }}
          >
            <ReceiptIcon width={17} height={17} /> Orders
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "advertising" });
            }}
          >
            <MegaphoneIcon width={17} height={17} /> Advertising
          </button>
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              nav.push({ name: "settings" });
            }}
          >
            <SettingsIcon width={17} height={17} /> Settings
          </button>
          <button className="menu-item danger" role="menuitem" onClick={() => void logout()}>
            <LogOutIcon width={17} height={17} /> Log out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The invite landing strip. Shown above sign-in when the visitor arrived from
 * an invite link but has no account yet, so the link is not a dead end: it
 * names the Circle and, if the link is spent, says so plainly.
 */
function InviteLanding({ token }: { token: string }) {
  const [preview, setPreview] = useState<{
    circle: { name: string; description: string | null };
    role: string;
    usable: boolean;
    reason: string | null;
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api<{ circle: { name: string; description: string | null }; role: string; usable: boolean; reason: string | null }>(
      `/v1/invites/${token}`,
    )
      .then(setPreview)
      .catch(() => setFailed(true));
  }, [token]);

  if (failed) {
    return (
      <div className="notice" style={{ margin: "0 var(--space-4) var(--space-3)" }}>
        This invite link is not valid. Ask for a fresh one.
      </div>
    );
  }
  if (!preview) return null;

  const reasonText =
    preview.reason === "expired" ? "This invite has expired."
      : preview.reason === "used_up" ? "This invite has been used up."
        : preview.reason === "revoked" ? "This invite was revoked."
          : null;

  return (
    <div className="invite-banner" role="status">
      <span className="chip tiny">Circle invite</span>
      <p style={{ margin: "var(--space-2) 0 0", fontWeight: 600 }}>
        You have been invited to {preview.circle.name}
      </p>
      {preview.circle.description && (
        <p className="meta" style={{ margin: "4px 0 0" }}>{preview.circle.description}</p>
      )}
      <p className="meta" style={{ marginTop: "var(--space-2)" }}>
        {reasonText ?? "Sign up or log in below and you will join automatically."}
      </p>
    </div>
  );
}
