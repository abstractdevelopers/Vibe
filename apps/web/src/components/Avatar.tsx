import { mediaSrc } from "../api";
import { Avatar2D } from "./Avatar2D";

interface Props {
  name: string;
  url?: string | null;
  size?: "sm" | "md" | "lg";
  /** Extra classes, e.g. "violet" for Circle avatars. */
  className?: string;
  style?: React.CSSProperties;
  /** A stable id to draw the face from. Falls back to the display name. */
  seed?: string;
}

/**
 * A user avatar: the uploaded photo when there is one, otherwise a drawn face.
 *
 * The drawn face is a pure function of a stable seed, so it never changes
 * between sessions and needs no storage. A photo always wins — we never
 * replace someone's real picture with our drawing.
 */
export function Avatar({ name, url, size = "md", className = "", style, seed }: Props) {
  const classes = ["avatar", size === "sm" ? "sm" : "", className].filter(Boolean).join(" ");
  if (url) {
    return (
      <span className={classes} style={style} aria-hidden="true">
        <img src={mediaSrc(url)} alt="" loading="lazy" />
      </span>
    );
  }
  return (
    <span className={classes} style={style} aria-hidden="true">
      <Avatar2D seed={seed ?? name ?? "?"} fluid />
    </span>
  );
}
