import { useState } from "react";
import { api, ApiError, setToken } from "../api";
import type { Me } from "../types";

interface Props {
  me: Me;
  onMeChanged: () => void | Promise<void>;
}

export function YouScreen({ me, onMeChanged }: Props) {
  const [privacy, setPrivacy] = useState(me.privacy);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function savePrivacy() {
    setSaving(true);
    setMessage(null);
    try {
      await api("/v1/me/privacy", { method: "PATCH", body: privacy });
      setMessage("Privacy settings saved.");
      await onMeChanged();
    } catch (err) {
      setMessage(err instanceof ApiError ? err.message : "Could not save settings");
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

      <div className="card">
        <div className="row">
          <span className="avatar" aria-hidden="true">
            {me.displayName.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <div style={{ fontWeight: 600 }}>{me.displayName}</div>
            <div className="meta">
              @{me.handle} · {me.email}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <h3>Privacy</h3>
        <Toggle
          id="discoverable"
          label="Discoverable in search"
          checked={privacy.discoverable}
          onChange={(v) => setPrivacy({ ...privacy, discoverable: v })}
        />
        <Toggle
          id="readReceipts"
          label="Send read receipts"
          checked={privacy.readReceipts}
          onChange={(v) => setPrivacy({ ...privacy, readReceipts: v })}
        />
        <Toggle
          id="locationEnabled"
          label="Location features (off by default)"
          checked={privacy.locationEnabled}
          onChange={(v) => setPrivacy({ ...privacy, locationEnabled: v })}
        />
        <Toggle
          id="contactsSyncEnabled"
          label="Contact syncing (off by default)"
          checked={privacy.contactsSyncEnabled}
          onChange={(v) => setPrivacy({ ...privacy, contactsSyncEnabled: v })}
        />

        <label htmlFor="profileAudience">Profile audience</label>
        <select
          id="profileAudience"
          value={privacy.profileAudience}
          onChange={(e) => setPrivacy({ ...privacy, profileAudience: e.target.value as Me["privacy"]["profileAudience"] })}
        >
          <option value="public">Public</option>
          <option value="connections">Connections</option>
          <option value="private">Private</option>
        </select>

        {message && <div className="notice">{message}</div>}
        <button className="btn primary" onClick={() => void savePrivacy()} disabled={saving}>
          {saving ? "Saving…" : "Save privacy settings"}
        </button>
      </div>

      <div className="card">
        <h3>Appearance &amp; account</h3>
        <button className="btn" onClick={toggleTheme}>
          Toggle light / dark theme
        </button>
        <button className="btn danger" style={{ marginTop: "var(--space-2)" }} onClick={() => void logout()}>
          Log out
        </button>
      </div>

      <div className="card">
        <h3>Payments</h3>
        <p className="muted">
          Vibe tracks and coordinates shared expenses. It does not hold your money. Provider-backed
          purchases are not enabled in this version.
        </p>
      </div>
    </div>
  );
}

function Toggle({
  id,
  label,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="row spread" style={{ marginBottom: "var(--space-2)" }}>
      <label htmlFor={id} style={{ marginBottom: 0 }}>
        {label}
      </label>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: 44, minHeight: 24, marginBottom: 0 }}
      />
    </div>
  );
}
