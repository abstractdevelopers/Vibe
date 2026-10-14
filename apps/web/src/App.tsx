import { useCallback, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./api";
import { AuthScreen } from "./screens/Auth";
import { HomeScreen } from "./screens/Home";
import { CirclesScreen } from "./screens/Circles";
import { ExploreScreen } from "./screens/Explore";
import { YouScreen } from "./screens/You";
import { CreateSheet } from "./components/CreateSheet";
import type { Me } from "./types";

export type Tab = "home" | "circles" | "create" | "explore" | "you";

const TABS: Array<{ id: Tab; label: string; icon: string }> = [
  { id: "home", label: "Home", icon: "🏠" },
  { id: "circles", label: "Circles", icon: "👥" },
  { id: "create", label: "Create", icon: "+" },
  { id: "explore", label: "Explore", icon: "🧭" },
  { id: "you", label: "You", icon: "🙂" },
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
    const theme = localStorage.getItem("vibe.theme");
    if (theme) document.documentElement.dataset.theme = theme;
  }, []);

  const bump = () => setRefreshKey((k) => k + 1);

  if (checking) {
    return (
      <div className="app-shell">
        <div className="skeleton" aria-label="Loading" />
      </div>
    );
  }

  if (!me) {
    return (
      <AuthScreen
        onAuthenticated={async () => {
          setChecking(true);
          await loadMe();
        }}
      />
    );
  }

  return (
    <>
      <header className="topbar">
        <span className="wordmark">Vibe</span>
        <div className="row">
          <button
            className="icon-button"
            aria-label={`Inbox, ${unread} unread`}
            onClick={() => setTab("home")}
          >
            ✉️
            {unread > 0 && <span className="badge">{unread}</span>}
          </button>
        </div>
      </header>

      <main className="app-shell">
        {tab === "home" && <HomeScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
        {tab === "circles" && <CirclesScreen me={me} refreshKey={refreshKey} onChanged={bump} />}
        {tab === "explore" && <ExploreScreen />}
        {tab === "you" && <YouScreen me={me} onMeChanged={loadMe} />}
      </main>

      <nav className="bottom-nav" aria-label="Primary">
        {TABS.map((item) =>
          item.id === "create" ? (
            <button
              key={item.id}
              className="create"
              aria-label="Create"
              onClick={() => setCreateOpen(true)}
            >
              <span aria-hidden="true">+</span>
            </button>
          ) : (
            <button
              key={item.id}
              aria-current={tab === item.id ? "page" : undefined}
              onClick={() => setTab(item.id)}
            >
              <span aria-hidden="true">{item.icon}</span>
              {item.label}
            </button>
          ),
        )}
      </nav>

      {createOpen && (
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

export { ApiError };
