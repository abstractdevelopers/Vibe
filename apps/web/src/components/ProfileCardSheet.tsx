import { useEffect, useRef, useState } from "react";
import type { PublicProfile } from "../types";
import { CheckIcon, CloseIcon, DownloadIcon, ShareIcon } from "./Icons";
import { Avatar } from "./Avatar";

type CardTheme = "editorial" | "midnight" | "sun";

const THEMES: { id: CardTheme; label: string; bg: string; ink: string; sub: string; accent: string }[] = [
  { id: "editorial", label: "Editorial", bg: "#ffffff", ink: "#14161c", sub: "#5c6070", accent: "#5b5bd6" },
  { id: "midnight", label: "Midnight", bg: "#14161c", ink: "#f4f5f8", sub: "#a3a7b8", accent: "#8b8bf0" },
  { id: "sun", label: "Sun", bg: "#fdf6ec", ink: "#2a2118", sub: "#7a6a58", accent: "#e0663c" },
];

interface Props {
  profile: PublicProfile;
  interests?: string[];
  onClose: () => void;
}

/**
 * A shareable profile card.
 *
 * The card is drawn to a canvas so it can be downloaded as an image, and it can
 * also be shared as a link through the Web Share API. Only what the profile
 * already exposes publicly is drawn: name, handle, bio, interests and follower
 * count. No email, no coarse location, nothing private.
 */
export function ProfileCardSheet({ profile, interests = [], onClose }: Props) {
  const [theme, setTheme] = useState<CardTheme>("editorial");
  const [status, setStatus] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const palette = THEMES.find((t) => t.id === theme)!;
  const shareUrl = `${location.origin}/u/${profile.handle}`;

  async function draw(): Promise<HTMLCanvasElement> {
    const canvas = canvasRef.current ?? document.createElement("canvas");
    const W = 1080;
    const H = 1350;
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");

    ctx.fillStyle = palette.bg;
    ctx.fillRect(0, 0, W, H);

    // A quiet accent bar instead of a gradient wash, matching the flat look.
    ctx.fillStyle = palette.accent;
    ctx.fillRect(0, 0, W, 14);

    ctx.fillStyle = palette.ink;
    ctx.font = "700 44px Georgia, 'Times New Roman', serif";
    ctx.fillText("Vibe", 72, 120);

    // Avatar: the photo when we can load it, otherwise the initial.
    const cx = 72 + 110;
    const cy = 330;
    const r = 110;
    let drewPhoto = false;
    if (profile.avatarUrl) {
      try {
        const img = await loadImage(profile.avatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        ctx.restore();
        drewPhoto = true;
      } catch {
        drewPhoto = false;
      }
    }
    if (!drewPhoto) {
      ctx.fillStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#ffffff";
      ctx.font = "700 110px Georgia, 'Times New Roman', serif";
      ctx.textAlign = "center";
      ctx.fillText(profile.displayName.slice(0, 1).toUpperCase(), cx, cy + 40);
      ctx.textAlign = "left";
    }

    ctx.fillStyle = palette.ink;
    ctx.font = "700 68px Georgia, 'Times New Roman', serif";
    ctx.fillText(truncate(ctx, profile.displayName, W - 144), 72, 560);

    ctx.fillStyle = palette.sub;
    ctx.font = "400 40px system-ui, -apple-system, sans-serif";
    ctx.fillText(`@${profile.handle}`, 72, 620);

    if (profile.bio) {
      ctx.fillStyle = palette.ink;
      ctx.font = "400 38px system-ui, -apple-system, sans-serif";
      const lines = wrap(ctx, profile.bio, W - 144).slice(0, 4);
      lines.forEach((line, i) => ctx.fillText(line, 72, 720 + i * 54));
    }

    if (interests.length > 0) {
      let x = 72;
      let y = 960;
      ctx.font = "500 30px system-ui, -apple-system, sans-serif";
      for (const topic of interests.slice(0, 6)) {
        const label = `#${topic}`;
        const w = ctx.measureText(label).width + 44;
        if (x + w > W - 72) {
          x = 72;
          y += 66;
        }
        ctx.fillStyle = palette.accent;
        roundRect(ctx, x, y - 34, w, 50, 25);
        ctx.fill();
        ctx.fillStyle = "#ffffff";
        ctx.fillText(label, x + 22, y);
        x += w + 16;
      }
    }

    ctx.fillStyle = palette.sub;
    ctx.font = "400 32px system-ui, -apple-system, sans-serif";
    ctx.fillText(`${profile.followerCount} followers · ${shareUrl.replace(/^https?:\/\//, "")}`, 72, H - 90);

    return canvas;
  }

  async function download() {
    setStatus(null);
    try {
      const canvas = await draw();
      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `vibe-${profile.handle}.png`;
      a.click();
      setStatus("Card downloaded");
    } catch {
      setStatus("Could not create the card image");
    }
  }

  async function share() {
    setStatus(null);
    try {
      if (navigator.share) {
        await navigator.share({ title: `${profile.displayName} on Vibe`, text: `@${profile.handle} on Vibe`, url: shareUrl });
        setStatus("Shared");
      } else {
        await navigator.clipboard?.writeText(shareUrl);
        setStatus("Link copied");
      }
    } catch {
      /* the user dismissed the share sheet; nothing to do */
    }
  }

  return (
    <div className="sheet" role="dialog" aria-modal="true" aria-label="Share profile card" onClick={onClose}>
      <div className="sheet-inner" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-handle" aria-hidden="true" />
        <div className="row spread" style={{ marginBottom: "var(--space-3)" }}>
          <div>
            <p className="eyebrow">Profile card</p>
            <h2 style={{ fontSize: "var(--text-title)", letterSpacing: "var(--tracking-display)" }}>
              Share {profile.displayName.split(" ")[0]}
            </h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon width={18} height={18} />
          </button>
        </div>

        <div className="pill-row" role="tablist" aria-label="Card style">
          {THEMES.map((t) => (
            <button
              key={t.id}
              className="pill"
              role="tab"
              aria-pressed={theme === t.id}
              onClick={() => setTheme(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className={`profile-card card-${theme}`} aria-hidden="true">
          <div className="profile-card-top">
            <span className="profile-card-wordmark">Vibe</span>
            <span className="profile-card-handle">@{profile.handle}</span>
          </div>
          <div className="profile-card-body">
            <Avatar
              name={profile.displayName}
              url={profile.avatarUrl}
              style={{ width: 72, height: 72, fontSize: 28 }}
            />
            <h3 className="profile-card-name">{profile.displayName}</h3>
            {profile.bio && <p className="profile-card-bio">{profile.bio}</p>}
            {interests.length > 0 && (
              <div className="profile-card-topics">
                {interests.slice(0, 5).map((topic) => (
                  <span key={topic} className="profile-card-topic">
                    #{topic}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="profile-card-foot">{profile.followerCount} followers</div>
        </div>

        {status && (
          <div className="notice success" style={{ marginTop: "var(--space-3)" }}>
            <CheckIcon width={16} height={16} /> {status}
          </div>
        )}

        <div className="row" style={{ gap: "var(--space-2)", marginTop: "var(--space-3)" }}>
          <button className="btn primary grow" onClick={() => void share()}>
            <ShareIcon width={18} height={18} /> Share link
          </button>
          <button className="btn grow" onClick={() => void download()}>
            <DownloadIcon width={18} height={18} /> Download card
          </button>
        </div>
      </div>
      <canvas ref={canvasRef} style={{ display: "none" }} />
    </div>
  );
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = src;
  });
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}
