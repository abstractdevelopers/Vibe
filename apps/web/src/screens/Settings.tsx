import { useState } from "react";
import { api, ApiError, setToken } from "../api";
import type { Me } from "../types";
import { ArrowLeftIcon, GlobeIcon, LogOutIcon, MoonIcon, ShieldIcon, WalletIcon } from "../components/Icons";

interface Props {
  me: Me;
  onBack: () => void;
  onMeChanged: () => void | Promise<void>;
}

/**
 * Settings is the single, predictable home for account-level controls. Logout
 * lives here and in the top-bar menu so it is never more than one tap away.
 */
export function SettingsScreen({ me, onBack, onMeChanged }: Props) {
  const [privacy, setPrivacy] = useState(me.privacy);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

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
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title">Settings</h1>

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
          <WalletIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Payments</span>
        </div>
        <p className="muted" style={{ margin: 0 }}>
          Vibe tracks and coordinates shared expenses. It does not hold your money, and provider-backed
          purchases are not enabled in this version.
        </p>
      </div>

      <button className="btn danger block" onClick={() => void logout()}>
        <LogOutIcon width={18} height={18} /> Log out
      </button>
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
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      htmlFor={id}
      className="row spread"
      style={{ padding: "var(--space-3) 0", borderBottom: "1px solid var(--hairline)", cursor: "pointer" }}
    >
      <span>
        <span style={{ display: "block", fontWeight: 600 }}>{label}</span>
        <span className="meta">{hint}</span>
      </span>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        style={{ width: "auto", margin: 0 }}
      />
    </label>
  );
}
