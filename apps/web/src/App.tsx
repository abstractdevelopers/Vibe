import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import { AuthScreen } from "./screens/Auth";
import { HomeScreen } from "./screens/Home";
import { CirclesScreen } from "./screens/Circles";
import { ExploreScreen } from "./screens/Explore";
import { YouScreen } from "./screens/You";
import { InboxScreen } from "./screens/Inbox";
import { ProfileScreen } from "./screens/Profile";
import { PlanDetailScreen } from "./screens/PlanDetail";
import { ExpenseDetailScreen } from "./screens/ExpenseDetail";
import { CreateSheet } from "./components/CreateSheet";
import { CirclesIcon, CompassIcon, HomeIcon, InboxIcon, PlusIcon, UserIcon } from "./components/Icons";
import { NavContext, type Route } from "./nav";
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
  const [refreshKey, setRefreshKey] = useState(0);

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
            <button
              className="icon-button"
              aria-label={unread > 0 ? `Inbox, ${unread} unread` : "Inbox"}
              onClick={() => push({ name: "inbox" })}
            >
              <InboxIcon width={20} height={20} />
              {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
            </button>
          </header>

          <main className="app-shell">
            {route.name === "tabs" && (
              <>
                {tab === "home" && <HomeScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
                {tab === "circles" && <CirclesScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
                {tab === "explore" && <ExploreScreen />}
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
          </main>

          <nav className="bottom-nav" aria-label="Primary">
            <NavButton id="home" label="Home" Icon={HomeIcon} tab={tab} setTab={setTab} route={route} onNavigate={back} />
            <NavButton id="circles" label="Circles" Icon={CirclesIcon} tab={tab} setTab={setTab} route={route} onNavigate={back} />
            <button className="create" aria-label="Create" onClick={() => setCreateOpen(true)}>
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
