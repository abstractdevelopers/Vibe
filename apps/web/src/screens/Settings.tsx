import { useEffect, useState } from "react";
import { api, ApiError, setToken } from "../api";
import type { Me } from "../types";
import { useNav } from "../nav";
import {
  ArrowLeftIcon,
  BellIcon,
  DownloadIcon,
  GlobeIcon,
  LogOutIcon,
  MoonIcon,
  ReceiptIcon,
  ShieldIcon,
  TrashIcon,
  WalletIcon,
} from "../components/Icons";

interface Props {
  me: Me;
  onBack: () => void;
  onMeChanged: () => void | Promise<void>;
}

interface NotificationPrefs {
  types: Record<string, boolean>;
  quietHoursEnabled: boolean;
  quietHoursStart: number | null;
  quietHoursEnd: number | null;
}

/** The notification families a person actually sees, with plain-language labels. */
const NOTIFICATION_LABELS: Array<{ key: string; label: string; hint: string }> = [
  { key: "circle_invite", label: "Circle invites", hint: "When someone invites you to a Circle" },
  { key: "plan_invite", label: "Plan invitations", hint: "When a plan is proposed for you" },
  { key: "plan_change", label: "Plan changes", hint: "When a plan's time, place or cost changes" },
  { key: "poll_closed", label: "Poll results", hint: "When a poll you voted in closes" },
  { key: "expense_update", label: "Shared money", hint: "Expense and split updates" },
  { key: "comment_reply", label: "Replies and mentions", hint: "When someone replies to or mentions you" },
  { key: "payment_reported", label: "Payment reported", hint: "When someone says they've paid" },
  { key: "payment_verified", label: "Payment verified", hint: "When a payment is confirmed" },
  { key: "message", label: "Messages", hint: "New direct messages" },
  { key: "gift", label: "Gifts", hint: "When someone sends you a gift" },
];

/**
 * Settings is the single, predictable home for account-level controls. Logout
 * lives here and in the top-bar menu so it is never more than one tap away.
 */
export function SettingsScreen({ me, onBack, onMeChanged }: Props) {
  const nav = useNav();
  const [privacy, setPrivacy] = useState(me.privacy);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [notifPrefs, setNotifPrefs] = useState<NotificationPrefs | null>(null);
  const [notifSaving, setNotifSaving] = useState(false);
  const [deletion, setDeletion] = useState<{ status: string; executeAfter?: string } | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    void api<NotificationPrefs>("/v1/me/notification-prefs").then(setNotifPrefs).catch(() => undefined);
    void api<{ status: string; executeAfter?: string }>("/v1/me/delete").then(setDeletion).catch(() => undefined);
  }, []);

  async function saveNotifications(next: NotificationPrefs) {
    setNotifPrefs(next);
    setNotifSaving(true);
    try {
      const saved = await api<NotificationPrefs>("/v1/me/notification-prefs", {
        method: "PATCH",
        body: {
          types: next.types,
          quietHoursEnabled: next.quietHoursEnabled,
          quietHoursStart: next.quietHoursStart,
          quietHoursEnd: next.quietHoursEnd,
        },
      });
      setNotifPrefs(saved);
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : "Could not save notifications" });
    } finally {
      setNotifSaving(false);
    }
  }

  async function exportData() {
    setExporting(true);
    setMessage(null);
    try {
      const data = await api<Record<string, unknown>>("/v1/me/export");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `vibe-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMessage({ tone: "ok", text: "Your data export has been downloaded." });
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : "Could not export your data" });
    } finally {
      setExporting(false);
    }
  }

  async function requestDeletion() {
    if (!window.confirm("Start account deletion? You have 24 hours to cancel before it completes.")) return;
    try {
      const res = await api<{ status: string; executeAfter: string }>("/v1/me/delete", { method: "POST" });
      setDeletion(res);
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : "Could not start deletion" });
    }
  }

  async function cancelDeletion() {
    try {
      await api("/v1/me/delete/cancel", { method: "POST" });
      setDeletion({ status: "cancelled" });
      setMessage({ tone: "ok", text: "Deletion cancelled. Your account stays as it is." });
    } catch (err) {
      setMessage({ tone: "bad", text: err instanceof ApiError ? err.message : "Could not cancel deletion" });
    }
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
        <p className="muted" style={{ marginTop: 0 }}>
          Vibe coordinates shared expenses and connects you to shops. It never holds your money:
          payments are collected by the payment provider, and an order is only marked paid once the
          provider confirms it.
        </p>
        <button className="btn block" onClick={() => nav.push({ name: "orders" })}>
          <ReceiptIcon width={18} height={18} /> Order history
        </button>
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <BellIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Notifications</span>
        </div>
        {notifPrefs === null ? (
          <div className="skeleton" aria-busy="true" />
        ) : (
          <>
            {NOTIFICATION_LABELS.map((item) => (
              <Toggle
                key={item.key}
                id={`notif-${item.key}`}
                label={item.label}
                hint={item.hint}
                checked={notifPrefs.types[item.key] !== false}
                disabled={notifSaving}
                onChange={(v) => void saveNotifications({ ...notifPrefs, types: { ...notifPrefs.types, [item.key]: v } })}
              />
            ))}
            <Toggle
              id="quietHours"
              label="Quiet hours"
              hint="Pause notifications overnight"
              checked={notifPrefs.quietHoursEnabled}
              disabled={notifSaving}
              onChange={(v) => void saveNotifications({ ...notifPrefs, quietHoursEnabled: v })}
            />
            {notifPrefs.quietHoursEnabled && (
              <div className="row" style={{ gap: "var(--space-3)", marginTop: "var(--space-2)" }}>
                <label style={{ flex: 1 }}>
                  From
                  <select
                    value={notifPrefs.quietHoursStart ?? 22}
                    onChange={(e) =>
                      void saveNotifications({ ...notifPrefs, quietHoursStart: Number(e.target.value) })
                    }
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  To
                  <select
                    value={notifPrefs.quietHoursEnd ?? 7}
                    onChange={(e) =>
                      void saveNotifications({ ...notifPrefs, quietHoursEnd: Number(e.target.value) })
                    }
                  >
                    {Array.from({ length: 24 }, (_, i) => (
                      <option key={i} value={i}>
                        {String(i).padStart(2, "0")}:00
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: "var(--space-3)" }}>
        <div className="row" style={{ gap: "var(--space-2)", marginBottom: "var(--space-3)" }}>
          <DownloadIcon width={18} height={18} style={{ color: "var(--violet-soft)" }} />
          <span className="section-title">Your data</span>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Download a copy of your profile, posts, Circles and activity. It never includes other people&rsquo;s private
          messages or your credentials.
        </p>
        <button className="btn block" onClick={() => void exportData()} disabled={exporting}>
          <DownloadIcon width={18} height={18} /> {exporting ? "Preparing…" : "Download my data"}
        </button>

        <div className="row" style={{ gap: "var(--space-2)", margin: "var(--space-5) 0 var(--space-3)" }}>
          <TrashIcon width={18} height={18} style={{ color: "var(--danger, #FF7182)" }} />
          <span className="section-title">Delete account</span>
        </div>
        {deletion?.status === "pending" ? (
          <div>
            <div className="notice danger">
              Deletion is scheduled. It completes on{" "}
              {deletion.executeAfter ? new Date(deletion.executeAfter).toLocaleString() : "24 hours from now"}. You can
              cancel any time before then.
            </div>
            <button className="btn block" onClick={() => void cancelDeletion()}>
              Cancel deletion
            </button>
          </div>
        ) : (
          <>
            <p className="muted" style={{ marginTop: 0 }}>
              You get a 24-hour window to change your mind. After it passes, your profile and public content are
              removed and you can no longer sign in.
            </p>
            <button className="btn danger block" onClick={() => void requestDeletion()}>
              <TrashIcon width={18} height={18} /> Delete my account
            </button>
          </>
        )}
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
  disabled,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      htmlFor={id}
      className="row spread"
      style={{
        padding: "var(--space-3) 0",
        borderBottom: "1px solid var(--hairline)",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span>
        <span style={{ display: "block", fontWeight: 600 }}>{label}</span>
        <span className="meta">{hint}</span>
      </span>
      {/* A real switch: the checkbox is the accessible control, the track and
          knob are its visual. It carries an explicit On/Off word as well, so
          state is readable without relying on colour alone. */}
      <span className="row switch-wrap" style={{ gap: "var(--space-2)", flex: "0 0 auto" }}>
        <span className={`switch${checked ? " on" : ""}`} aria-hidden="true">
          <span className="switch-knob" />
        </span>
        <span className="switch-state meta" aria-hidden="true">{checked ? "On" : "Off"}</span>
        <input
          id={id}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="switch-input"
        />
      </span>
    </label>
  );
}
