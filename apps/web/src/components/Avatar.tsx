import { mediaSrc } from "../api";

interface Props {
  name: string;
  url?: string | null;
  size?: "sm" | "md" | "lg";
  /** Extra classes, e.g. "violet" for Circle avatars. */
  className?: string;
  style?: React.CSSProperties;
}

/**
 * A user avatar: the uploaded photo when there is one, otherwise the initial of
 * the display name. Sizing comes from the existing .avatar classes so this drops
 * into every place an avatar is already shown.
 */
export function Avatar({ name, url, size = "md", className = "", style }: Props) {
  const classes = ["avatar", size === "sm" ? "sm" : "", className].filter(Boolean).join(" ");
  return (
    <span className={classes} style={style} aria-hidden="true">
      {url ? <img src={mediaSrc(url)} alt="" loading="lazy" /> : name.slice(0, 1).toUpperCase() || "?"}
    </span>
  );
}
