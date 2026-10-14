import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import { AuthScreen } from "./screens/Auth";
import { HomeScreen, type CreateMode } from "./screens/Home";
import { CirclesScreen } from "./screens/Circles";
import { ExploreScreen } from "./screens/Explore";
import { YouScreen } from "./screens/You";
import { InboxScreen } from "./screens/Inbox";
import { ProfileScreen } from "./screens/Profile";
import { PlanDetailScreen } from "./screens/PlanDetail";
import { ExpenseDetailScreen } from "./screens/ExpenseDetail";
import { EditProfileScreen } from "./screens/EditProfile";
import { SettingsScreen } from "./screens/Settings";
import { PlaceDetailScreen } from "./screens/PlaceDetail";
import { CreateSheet } from "./components/CreateSheet";
import {
  CirclesIcon,
  CompassIcon,
  EditIcon,
  HomeIcon,
  InboxIcon,
  LogOutIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
} from "./components/Icons";
import { NavContext, useNav, type Route } from "./nav";
import { useRealtime } from "./realtime";
import type { Me } from "./types";

export type Tab = "home" | "circles" | "explore" | "you";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("home");
  const [route, setRoute] = useState<Route>({ name: "tabs" });
  const [unread, setUnread] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("post");
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
      setUnread(counts.unread);
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

  // A committed change elsewhere refreshes what this client is looking at.
  useRealtime(() => {
    setRefreshKey((k) => k + 1);
    void api<{ unread: number }>("/v1/notifications/unread-count")
      .then((counts) => setUnread(counts.unread))
      .catch(() => undefined);
  });

  useEffect(() => {
    const saved = localStorage.getItem("vibe.theme");
    if (saved) document.documentElement.dataset.theme = saved;
  }, []);

  const bump = () => setRefreshKey((k) => k + 1);
  const push = (next: Exclude<Route, { name: "tabs" }>) => setRoute(next);
  const back = () => setRoute({ name: "tabs" });

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
        <AuthScreen
          onAuthenticated={async () => {
            setChecking(true);
            await loadMe();
          }}
        />
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
              <AccountMenu me={me} onMeChanged={loadMe} onOpenProfile={() => push({ name: "profile", userId: me.id })} />
            </div>
          </header>

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
          </main>

          <nav className="bottom-nav" aria-label="Primary">
            <NavButton id="home" label="Home" Icon={HomeIcon} tab={tab} setTab={setTab} route={route} onNavigate={back} />
            <NavButton id="circles" label="Circles" Icon={CirclesIcon} tab={tab} setTab={setTab} route={route} onNavigate={back} />
            <button className="create" aria-label="Create" onClick={() => openCreate("post")}>
              <span>
                <PlusIcon width={22} height={22} />
              </span>
            </button>
            <NavButton id="explore" label="Explore" Icon={CompassIcon} tab={tab} setTab={setTab} route={route} onNavigate={back} />
            <NavButton id="you" label="You" Icon={UserIcon} tab={tab} setTab={setTab} route={route} onNavigate={back} />
          </nav>
        </>
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
}: {
  me: Me;
  onMeChanged: () => void | Promise<void>;
  onOpenProfile: () => void;
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
        className="avatar sm"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((v) => !v)}
      >
        {me.displayName.slice(0, 1).toUpperCase()}
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
