import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import { ArrowLeftIcon, CheckIcon, PassIcon, QrIcon, TrashIcon } from "../components/Icons";
import { EmptyState } from "../components/EmptyState";

interface Pass {
  id: string;
  token: string;
  status: string;
  share: { displayName: boolean; avatar: boolean; handle: boolean };
  createdAt: string;
}

/**
 * Vibe Pass (§4.9). The pass is a revocable pointer: the displayed token is what
 * an NFC tag or QR would carry, and it resolves server-side to this pass. The
 * holder chooses what a scan may reveal. Nothing personal is encoded in the
 * token itself.
 */
export function PassScreen({ onBack }: { onBack: () => void }) {
  const [pass, setPass] = useState<Pass | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api<{ pass: Pass | null }>("/v1/pass/me");
      setPass(res.pass);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your pass");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function create() {
    setBusy(true);
    try {
      await api("/v1/pass", { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create your pass");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    try {
      await api("/v1/pass/me/revoke", { method: "POST" });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not revoke your pass");
    } finally {
      setBusy(false);
    }
  }

  async function toggleShare(key: "displayName" | "avatar" | "handle") {
    if (!pass) return;
    const next = { ...pass.share, [key]: !pass.share[key] };
    setPass({ ...pass, share: next });
    try {
      await api("/v1/pass/me/share", {
        method: "PATCH",
        body: { shareDisplayName: next.displayName, shareAvatar: next.avatar, shareHandle: next.handle },
      });
    } catch {
      await load();
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>
      <h1 className="screen-title">Vibe Pass</h1>
      <p className="meta">
        A physical pass points at a revocable identifier. Nothing personal or payment-related is stored
        on the tag or the code.
      </p>

      {error && <div className="notice danger">{error}</div>}

      {pass === undefined && !error && <div className="skeleton" aria-busy="true" />}

      {pass === null && (
        <EmptyState
          icon={<PassIcon />}
          title="No pass yet"
          text="Create a pass to check in at events and redeem offers with merchants."
          action={
            <button className="btn primary" onClick={() => void create()} disabled={busy}>
              Create my pass
            </button>
          }
        />
      )}

      {pass && (
        <>
          <div className="card">
            <div className="row spread">
              <strong className="row" style={{ gap: "var(--space-2)" }}>
                <PassIcon width={20} height={20} /> Your pass
              </strong>
              <span className="audience-tag">{pass.status}</span>
            </div>
            <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)", alignItems: "center" }}>
              <span className="qr-frame" aria-hidden="true">
                <QrIcon width={40} height={40} />
              </span>
              <div className="grow">
                <div className="meta">Pass token (what the code carries)</div>
                <div style={{ fontFamily: "monospace", wordBreak: "break-all", fontSize: 13 }}>{pass.token}</div>
              </div>
            </div>
          </div>

          <h2 className="section-title">What a scan may show</h2>
          <div className="card">
            {(["displayName", "avatar", "handle"] as const).map((key) => (
              <label key={key} className="row spread" style={{ padding: "var(--space-2) 0", cursor: "pointer" }}>
                <span>{key === "displayName" ? "Display name" : key === "avatar" ? "Avatar" : "Handle"}</span>
                <input type="checkbox" checked={pass.share[key]} onChange={() => void toggleShare(key)} />
              </label>
            ))}
            <p className="meta" style={{ marginTop: "var(--space-2)" }}>
              Unchecked fields are hidden when someone scans you.
            </p>
          </div>

          {pass.status === "active" ? (
            <button className="btn danger" style={{ marginTop: "var(--space-3)" }} onClick={() => void revoke()} disabled={busy}>
              <TrashIcon width={16} height={16} /> Revoke pass
            </button>
          ) : (
            <button className="btn primary" style={{ marginTop: "var(--space-3)" }} onClick={() => void create()} disabled={busy}>
              <CheckIcon width={16} height={16} /> Create a new pass
            </button>
          )}
        </>
      )}
    </div>
  );
}
