import { useState } from "react";
import { api, ApiError } from "../api";
import type { Me } from "../types";
import { ArrowLeftIcon, CheckIcon, ImageIcon } from "../components/Icons";

interface Props {
  me: Me;
  onBack: () => void;
  onSaved: () => void | Promise<void>;
}

const SUGGESTED = [
  "music",
  "food",
  "sports",
  "travel",
  "art",
  "tech",
  "film",
  "fitness",
  "books",
  "gaming",
  "fashion",
  "outdoors",
];

export function EditProfileScreen({ me, onBack, onSaved }: Props) {
  const [displayName, setDisplayName] = useState(me.displayName);
  const [handle, setHandle] = useState(me.handle);
  const [bio, setBio] = useState(me.bio ?? "");
  const [interests, setInterests] = useState<string[]>(me.interests ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  function toggleInterest(topic: string) {
    setInterests((prev) => (prev.includes(topic) ? prev.filter((t) => t !== topic) : [...prev, topic]));
  }

  async function save() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api("/v1/me", {
        method: "PATCH",
        body: {
          displayName: displayName.trim(),
          handle: handle.trim(),
          bio: bio.trim() ? bio.trim() : null,
          interests,
        },
      });
      setDone(true);
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your profile");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={onBack} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      <h1 className="screen-title">Edit profile</h1>

      {error && <div className="notice danger">{error}</div>}
      {done && (
        <div className="notice success">
          <CheckIcon width={16} height={16} /> Profile updated.
        </div>
      )}

      <div className="card">
        <div className="row" style={{ gap: "var(--space-4)", marginBottom: "var(--space-4)" }}>
          <span className="avatar" style={{ width: 64, height: 64, fontSize: 24 }} aria-hidden="true">
            {displayName.slice(0, 1).toUpperCase() || "?"}
          </span>
          <div className="grow">
            <p className="meta" style={{ margin: 0 }}>
              Your avatar is generated from your name. Photo upload for avatars arrives with the media
              pipeline; you can already add photos to posts.
            </p>
          </div>
        </div>

        <label htmlFor="displayName">Display name</label>
        <input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={60} />

        <label htmlFor="handle">Handle</label>
        <div className="row" style={{ gap: "var(--space-2)" }}>
          <span className="meta" aria-hidden="true" style={{ fontSize: 16 }}>
            @
          </span>
          <input
            id="handle"
            value={handle}
            onChange={(e) => setHandle(e.target.value)}
            maxLength={30}
            style={{ marginBottom: 0 }}
          />
        </div>

        <label htmlFor="bio">Bio</label>
        <textarea
          id="bio"
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          maxLength={280}
          placeholder="A line about you"
          style={{ minHeight: 84 }}
        />
        <div className="meta" style={{ marginTop: "-8px", marginBottom: "var(--space-4)", textAlign: "right" }}>
          {bio.length}/280
        </div>

        <label>Interests</label>
        <p className="meta" style={{ marginTop: "-6px" }}>
          Used to rank Explore. Nothing is shared publicly unless your profile is public.
        </p>
        <div className="row" style={{ flexWrap: "wrap", gap: "var(--space-2)" }}>
          {SUGGESTED.map((topic) => (
            <button
              key={topic}
              className="pill"
              aria-pressed={interests.includes(topic)}
              onClick={() => toggleInterest(topic)}
            >
              {topic}
            </button>
          ))}
        </div>

        <button className="btn primary block" style={{ marginTop: "var(--space-5)" }} onClick={() => void save()} disabled={busy || !displayName.trim() || !handle.trim()}>
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>

      <p className="meta" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <ImageIcon width={14} height={14} /> Changing your handle keeps your posts and Circles.
      </p>
    </div>
  );
}
