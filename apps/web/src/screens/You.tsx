import { useCallback, useEffect, useState } from "react";
import { api, ApiError, setToken } from "../api";
import type { Me, PublicUser } from "../types";
import {
  EditIcon,
  GlobeIcon,
  LockIcon,
  LogOutIcon,
  MapPinIcon,
  MoonIcon,
  ShieldIcon,
  WalletIcon,
} from "../components/Icons";
import { useNav } from "../nav";

interface Props {
  me: Me;
  onMeChanged: () => void | Promise<void>;
}

export function YouScreen({ me, onMeChanged }: Props) {
  const nav = useNav();
  const [privacy, setPrivacy] = useState(me.privacy);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [blocked, setBlocked] = useState<PublicUser[]>([]);
  const [city, setCity] = useState("");
  const [area, setArea] = useState("");

  const loadBlocked = useCallback(async () => {
    try {
      const result = await api<{ blocked: PublicUser[] }>("/v1/users/blocked");
      setBlocked(result.blocked);
    } catch {
      /* the list is optional; leave it empty on failure */
    }
  }, []);

  useEffect(() => {
    void loadBlocked();
  }, [loadBlocked]);

  async function unblock(userId: string) {
    await api(`/v1/users/${userId}/block`, { method: "DELETE" });
    await loadBlocked();
  }

  async function savePrivacy() {
    setSaving(true);
    setMessage(null);
    try {
      await api("/v1/me/privacy", { method: "PATCH", body: privacy });
      setMessage({ tone: "ok", text: "Privacy settings saved." });
      await onMeChanged();
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : "Could not save settings" });
    } finally {
      setSaving(false);
    }
  }

  function toggleTheme() {
    const current = document.documentElement.dataset.theme;
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("vibe.theme", next);
  }

  async function logout() {
    try {
      await api("/v1/auth/logout", { method: "POST" });
    } finally {
      setToken(null);
      window.location.reload();
    }
  }

  return (
    <div>
      <h1 className="screen-title">You</h1>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-4)" }}>
          <span className="avatar" style={{ width: 56, height: 56, fontSize: 22 }} aria-hidden="true">
            {me.displayName.slice(0, 1).toUpperCase()}
          </span>
          <div className="grow">
            <div className="feed-author" style={{ fontSize: 18 }}>
              {me.displayName}
            </div>
            <div className="meta">
              @{me.handle} · {me.email}
            </div>
          </div>
          <button className="btn" onClick={() => nav.push({ name: "edit-profile" })}>
            <EditIcon width={16} height={16} /> Edit
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <MapPinIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Your area</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Used to rank Explore by area. This is a city and area label you type — Vibe never reads
          your device location and never stores coordinates.
        </p>
        <div className="row" style={{ gap: "var(--space-3)" }}>
          <div className="grow">
            <label htmlFor="youCity">City</label>
            <input
              id="youCity"
              value={city}
              onChange={(e) => setCity(e.target.value)}
              placeholder={me.city ?? "Lagos"}
            />
          </div>
          <div className="grow">
            <label htmlFor="youArea">Area</label>
            <input
              id="youArea"
              value={area}
              onChange={(e) => setArea(e.target.value)}
              placeholder={me.area ?? "Lekki"}
            />
          </div>
        </div>
        <button
          className="btn block"
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            setMessage(null);
            try {
              await api("/v1/me", {
                method: "PATCH",
                body: { city: city.trim() || null, area: area.trim() || null },
              });
              setMessage({ tone: "ok", text: "Area saved." });
              await onMeChanged();
            } catch (err) {
              setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : "Could not save" });
            } finally {
              setSaving(false);
            }
          }}
        >
          Save area
        </button>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <ShieldIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Privacy</span>
        </div>

        <Toggle
          id="discoverable"
          label="Discoverable in search"
          hint="Let people find you by handle"
          checked={privacy.discoverable}
          onChange={(v) => setPrivacy({ ...privacy, discoverable: v })}
        />
        <Toggle
          id="readReceipts"
          label="Read receipts"
          hint="Let others see when you've read a message"
          checked={privacy.readReceipts}
          onChange={(v) => setPrivacy({ ...privacy, readReceipts: v })}
        />
        <Toggle
          id="locationEnabled"
          label="Area-level discovery"
          hint="Uses the city and area you type — never your device location"
          checked={privacy.locationEnabled}
          onChange={(v) => setPrivacy({ ...privacy, locationEnabled: v })}
        />
        <Toggle
          id="contactsSyncEnabled"
          label="Contact syncing"
          hint="Off by default — never uploads your address book"
          checked={privacy.contactsSyncEnabled}
          onChange={(v) => setPrivacy({ ...privacy, contactsSyncEnabled: v })}
        />

        <label htmlFor="profileAudience" style={{ marginTop: "var(--space-4)" }}>
          Profile audience
        </label>
        <select
          id="profileAudience"
          value={privacy.profileAudience}
          onChange={(e) =>
            setPrivacy({ ...privacy, profileAudience: e.target.value as Me["privacy"]["profileAudience"] })
          }
        >
          <option value="public">Public</option>
          <option value="connections">Connections</option>
          <option value="private">Private</option>
        </select>

        {message && <div className={`notice ${message.tone === "ok" ? "success" : "danger"}`}>{message.text}</div>}

        <button className="btn primary block" onClick={() => void savePrivacy()} disabled={saving}>
          {saving ? "Saving…" : "Save privacy settings"}
        </button>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-4)" }}>
          <GlobeIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Appearance</span>
        </div>
        <button className="btn block" onClick={toggleTheme}>
          <MoonIcon width={18} height={18} /> Toggle light / dark
        </button>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <ShieldIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Blocked accounts</span>
        </div>
        {blocked.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            You haven&rsquo;t blocked anyone.
          </p>
        ) : (
          blocked.map((u) => (
            <div
              key={u.id}
              className="row spread"
              style={{ padding: "var(--space-2) 0", borderBottom: "1px solid var(--hairline)" }}
            >
              <span>
                {u.displayName} <span className="meta">@{u.handle}</span>
              </span>
              <button className="btn ghost" onClick={() => void unblock(u.id)}>
                Unblock
              </button>
            </div>
          ))
        )}
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <WalletIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Payments</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Vibe tracks and coordinates shared expenses. It does not hold your money, and
          provider-backed purchases are not enabled in this version.
        </p>
      </div>

      <button className="btn danger block" onClick={() => void logout()}>
        <LogOutIcon width={18} height={18} /> Log out
      </button>

      <p className="meta" style={{ textAlign: "center", marginTop: "var(--space-5)", display: "flex", gap: 6, justifyContent: "center" }}>
        <LockIcon width={13} height={13} /> Your data stays yours.
      </p>
    </div>
  );
}

function Toggle({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="row spread" style={{ padding: "var(--space-3) 0", borderBottom: "1px solid var(--hairline)" }}>
      <div className="grow" style={{ paddingRight: "var(--space-3)" }}>
        <label htmlFor={id} style={{ marginBottom: 0, color: "var(--text)" }}>
          {label}
        </label>
        <div className="meta">{hint}</div>
      </div>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          width: 46,
          minHeight: 26,
          height: 26,
          marginBottom: 0,
          accentColor: "var(--coral)",
          cursor: "pointer",
          flex: "0 0 auto",
        }}
      />
    </div>
  );
}
