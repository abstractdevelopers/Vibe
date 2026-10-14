import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import { AuthScreen } from "./screens/Auth";
import { HomeScreen } from "./screens/Home";
import { CirclesScreen } from "./screens/Circles";
import { ExploreScreen } from "./screens/Explore";
import { YouScreen } from "./screens/You";
import { CreateSheet } from "./components/CreateSheet";
import {
  CirclesIcon,
  CompassIcon,
  HomeIcon,
  InboxIcon,
  PlusIcon,
  UserIcon,
} from "./components/Icons";
import type { Me } from "./types";

export type Tab = "home" | "circles" | "create" | "explore" | "you";

const TABS = [
  { id: "home" as const, label: "Home", Icon: HomeIcon },
  { id: "circles" as const, label: "Circles", Icon: CirclesIcon },
  { id: "explore" as const, label: "Explore", Icon: CompassIcon },
  { id: "you" as const, label: "You", Icon: UserIcon },
];

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(true);
  const [tab, setTab] = useState<Tab>("home");
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

  useEffect(() => {
    const saved = localStorage.getItem("vibe.theme");
    if (saved) document.documentElement.dataset.theme = saved;
  }, []);

  const bump = () => setRefreshKey((k) => k + 1);

  return (
    <>
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
              onClick={() => setTab("home")}
            >
              <InboxIcon width={20} height={20} />
              {unread > 0 && <span className="badge">{unread > 99 ? "99+" : unread}</span>}
            </button>
          </header>

          <main className="app-shell">
            {tab === "home" && <HomeScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
            {tab === "circles" && <CirclesScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
            {tab === "explore" && <ExploreScreen />}
            {tab === "you" && <YouScreen me={me} onMeChanged={loadMe} />}
          </main>

          <nav className="bottom-nav" aria-label="Primary">
            <NavButton tab={tab} setTab={setTab} {...TABS[0]!} />
            <NavButton tab={tab} setTab={setTab} {...TABS[1]!} />
            <button className="create" aria-label="Create" onClick={() => setCreateOpen(true)}>
              <span>
                <PlusIcon width={22} height={22} />
              </span>
            </button>
            <NavButton tab={tab} setTab={setTab} {...TABS[2]!} />
            <NavButton tab={tab} setTab={setTab} {...TABS[3]!} />
          </nav>
        </>
      )}

      {createOpen && me && (
        <CreateSheet
          me={me}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            setTab("home");
            bump();
          }}
        />
      )}
    </>
  );
}

function NavButton({
  id,
  label,
  Icon,
  tab,
  setTab,
}: {
  id: Tab;
  label: string;
  Icon: typeof HomeIcon;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const active = tab === id;
  return (
    <button aria-current={active ? "page" : undefined} onClick={() => setTab(id)}>
      <Icon />
      {label}
    </button>
  );
}

export { ApiError };
