import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "../api";
import type { FeedItem, Me, PublicProfile } from "../types";
import {
  ArrowLeftIcon,
  AtIcon,
  ChatIcon,
  CheckIcon,
  EditIcon,
  HeartIcon,
  ShareIcon,
  UserIcon,
  ShieldIcon,
  UsersIcon,
} from "../components/Icons";
import { useNav } from "../nav";
import { Avatar } from "../components/Avatar";
import { EmptyState } from "../components/EmptyState";
import { ReportSheet } from "../components/ReportSheet";
import { ProfileCardSheet } from "../components/ProfileCardSheet";

interface Props {
  userId: string;
  me: Me;
  onChanged: () => void;
}

export function ProfileScreen({ userId, me, onChanged }: Props) {
  const nav = useNav();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [posts, setPosts] = useState<FeedItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [cardOpen, setCardOpen] = useState(false);
  const isSelf = userId === me.id;

  const load = useCallback(async () => {
    setError(null);
    try {
      const [p, feed] = await Promise.all([
        api<PublicProfile>(`/v1/users/${userId}`),
        api<{ items: FeedItem[] }>(`/v1/users/${userId}/posts`),
      ]);
      setProfile(p);
      setPosts(feed.items ?? []);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load this profile");
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function follow() {
    setBusy(true);
    try {
      await api("/v1/follows", { body: { followeeId: userId } });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not follow");
    } finally {
      setBusy(false);
    }
  }

  async function unfollow() {
    setBusy(true);
    try {
      await api(`/v1/follows/${userId}`, { method: "DELETE" });
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not unfollow");
    } finally {
      setBusy(false);
    }
  }

  async function block() {
    setBusy(true);
    try {
      if (profile?.viewerHasBlocked) {
        await api(`/v1/users/${userId}/block`, { method: "DELETE" });
      } else {
        await api(`/v1/users/${userId}/block`, { method: "POST" });
      }
      setError(null);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the block");
    } finally {
      setBusy(false);
    }
  }

  async function message() {
    setBusy(true);
    try {
      const result = await api<{ id: string }>("/v1/conversations", { body: { userId } });
      nav.push({ name: "conversation", conversationId: result.id });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not start a conversation");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button className="btn ghost" onClick={() => nav.back()} style={{ paddingLeft: 0, marginBottom: "var(--space-3)" }}>
        <ArrowLeftIcon width={18} height={18} /> Back
      </button>

      {error && <div className="notice danger">{error}</div>}
      {!profile && !error && <div className="skeleton" aria-busy="true" />}

      {profile && (
        <>
          <div className="card" style={{ marginBottom: "var(--space-3)" }}>
            <div className="row" style={{ gap: "var(--space-4)", marginBottom: "var(--space-3)" }}>
              <Avatar name={profile.displayName} url={profile.avatarUrl} seed={profile.id} style={{ width: 64, height: 64, fontSize: 24 }} />
              <div className="grow">
                <h1 style={{ fontSize: 22 }}>{profile.displayName}</h1>
                <div className="meta">
                  <AtIcon width={12} height={12} style={{ verticalAlign: "-2px" }} />
                  {profile.handle}
                </div>
              </div>
            </div>

            {profile.bio && <p style={{ marginTop: 0 }}>{profile.bio}</p>}

            <div className="row" style={{ gap: "var(--space-5)", marginBottom: "var(--space-4)" }}>
              <div>
                <div className="stat">{profile.followerCount}</div>
                <div className="stat-label">Followers</div>
              </div>
              <div>
                <div className="stat">{posts.length}</div>
                <div className="stat-label">Posts</div>
              </div>
            </div>

            {!isSelf && (
              <div className="profile-actions">
                {profile.viewerFollows ? (
                  <button className="btn small" onClick={() => void unfollow()} disabled={busy}>
                    <CheckIcon width={15} height={15} /> Following
                  </button>
                ) : (
                  <button className="btn primary small" onClick={() => void follow()} disabled={busy}>
                    <UsersIcon width={15} height={15} /> {profile.viewerRequested ? "Requested" : "Follow"}
                  </button>
                )}
                <button className="btn small" onClick={() => void message()} disabled={busy}>
                  <ChatIcon width={15} height={15} /> Message
                </button>
                <button className="btn small" onClick={() => setCardOpen(true)}>
                  <ShareIcon width={15} height={15} /> Share card
                </button>
                <button
                  className={`btn small${profile.viewerHasBlocked ? " danger" : ""}`}
                  onClick={() => void block()}
                  disabled={busy}
                  aria-pressed={profile.viewerHasBlocked}
                >
                  <ShieldIcon width={15} height={15} /> {profile.viewerHasBlocked ? "Blocked" : "Block"}
                </button>
                <button className="btn small ghost" onClick={() => setReporting(true)} aria-label="Report this profile">
                  Report
                </button>
              </div>
            )}
            {isSelf && (
              <div className="profile-actions">
                <button className="btn primary small" onClick={() => nav.push({ name: "edit-profile" })}>
                  <EditIcon width={15} height={15} /> Edit profile
                </button>
                <button className="btn small" onClick={() => setCardOpen(true)}>
                  <ShareIcon width={15} height={15} /> Share my card
                </button>
              </div>
            )}
          </div>

          <h3 className="section-title" style={{ margin: "var(--space-4) 0 var(--space-3)" }}>
            Posts
          </h3>
          {posts.length === 0 && (
            <EmptyState
              icon={<UserIcon />}
              title="Nothing public to show yet"
              text="Posts appear here once this person shares something publicly."
            />
          )}
          {posts.map((post) => (
            <article key={post.id} className="post">
              <div className="meta" style={{ marginBottom: "var(--space-2)" }}>
                {new Date(post.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ·{" "}
                {post.audience}
              </div>
              {post.body && <p className="post-body">{post.body}</p>}
              <div className="post-actions">
                <span className="react-btn" aria-hidden="true">
                  <HeartIcon width={19} height={19} /> {post.reactionCount}
                </span>
                <span className="react-btn" aria-hidden="true">
                  <ShareIcon width={19} height={19} />
                </span>
              </div>
            </article>
          ))}
        </>
      )}

      {reporting && (
        <ReportSheet targetType="user" targetId={userId} onClose={() => setReporting(false)} />
      )}

      {cardOpen && profile && (
        <ProfileCardSheet profile={profile} interests={profile.interests ?? []} onClose={() => setCardOpen(false)} />
      )}
    </div>
  );
}
