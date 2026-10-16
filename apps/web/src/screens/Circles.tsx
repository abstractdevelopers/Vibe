import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { CircleSummary, Me } from "../types";
import { EmptyState } from "../components/EmptyState";
import { ScreenHeader } from "../components/ScreenHeader";
import { CheckIcon, CirclesIcon, LockIcon, PlusIcon } from "../components/Icons";
import { useNav } from "../nav";

interface Props {
  me: Me;
  refreshKey: number;
  onChanged: () => void;
}

export function CirclesScreen({ refreshKey, onChanged }: Props) {
  const nav = useNav();
  const [circles, setCircles] = useState<CircleSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const loadCircles = useCallback(async () => {
    try {
      const result = await api<{ circles: CircleSummary[] }>("/v1/circles");
      setCircles(result.circles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load Circles");
    }
  }, []);

  useEffect(() => {
    void loadCircles();
  }, [loadCircles, refreshKey]);

  async function createCircle() {
    if (!name.trim()) return;
    try {
      const result = await api<{ id: string }>("/v1/circles", {
        body: { name: name.trim(), privacy: "private" },
      });
      setName("");
      setShowCreate(false);
      await loadCircles();
      nav.push({ name: "circle", circleId: result.id });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create the Circle");
    }
  }


  return (
    <div>
      <ScreenHeader
        eyebrow="Your people"
        title="Circles"
        subtitle="Small groups where talk turns into plans, money and memories."
        action={
          <button className="btn" onClick={() => setShowCreate((v) => !v)} aria-expanded={showCreate}>
            <PlusIcon width={18} height={18} /> New
          </button>
        }
      />

      {notice && (
        <div className="notice success">
          <CheckIcon width={16} height={16} /> {notice}
        </div>
      )}
      {error && <div className="notice danger">{error}</div>}

      {showCreate && (
        <div className="card" style={{ marginBottom: "var(--space-4)" }}>
          <h3 className="section-title" style={{ marginBottom: "var(--space-3)" }}>
            New Circle
          </h3>
          <label htmlFor="circleName">Name</label>
          <input
            id="circleName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Weekend crew, Housemates, Book club…"
          />
          <p className="meta" style={{ marginBottom: "var(--space-3)" }}>
            <LockIcon width={13} height={13} style={{ verticalAlign: "-2px" }} /> Private by default. Invite people after.
          </p>
          <button className="btn primary block" onClick={() => void createCircle()} disabled={!name.trim()}>
            Create Circle
          </button>
        </div>
      )}

      {circles === null && <div className="skeleton" aria-busy="true" />}

      {circles?.length === 0 && (
        <EmptyState
          icon={<CirclesIcon />}
          title="No Circles yet"
          text="A Circle is your group space — plans, shared money and memories in one place."
          action={
            <button className="btn primary" onClick={() => setShowCreate(true)}>
              <PlusIcon width={18} height={18} /> Create your first Circle
            </button>
          }
        />
      )}

      {circles?.map((circle) => {
        return (
          <button
            key={circle.id}
            className="card interactive"
            style={{ display: "block", width: "100%", textAlign: "left", marginBottom: "var(--space-3)" }}
            onClick={() => nav.push({ name: "circle", circleId: circle.id })}
          >
            <div className="row spread">
              <div className="row" style={{ gap: "var(--space-3)" }}>
                <span className="avatar violet" aria-hidden="true">
                  {circle.name.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <div className="feed-author">{circle.name}</div>
                  <div className="meta">
                    {circle.member_count} {circle.member_count === 1 ? "member" : "members"}
                  </div>
                </div>
              </div>
              <span className="audience-tag">
                {circle.privacy === "private" ? (
                  <LockIcon width={12} height={12} />
                ) : null}
                {circle.privacy.replace("_", " ")}
              </span>
            </div>
          </button>
        );
      })}

    </div>
  );
}

