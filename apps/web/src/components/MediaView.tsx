import { isVideoUrl } from "../media";
import { mediaSrc } from "../api";

/**
 * Renders one stored media URL as either an image or a video.
 *
 * The API assigns the extension from the content type, so the URL itself says
 * which it is — no extra field has to be carried through the feed, a message or
 * a post. Video gets `controls` and `playsInline` so it does not hijack the
 * screen on iOS.
 */
export function MediaView({ url, alt = "" }: { url: string; alt?: string }) {
  const src = mediaSrc(url);
  if (isVideoUrl(url)) {
    return <video className="media-video" src={src} controls playsInline preload="metadata" />;
  }
  return <img src={src} alt={alt} loading="lazy" />;
}

/** A set of media, laid out as one hero or a grid, images and video alike. */
export function MediaGrid({ urls, className = "post-media" }: { urls: string[]; className?: string }) {
  if (urls.length === 0) return null;
  if (urls.length === 1) {
    return (
      <div className={className}>
        <MediaView url={urls[0]!} />
      </div>
    );
  }
  return (
    <div className={`${className} post-media-grid`}>
      {urls.slice(0, 4).map((url) => (
        <MediaView key={url} url={url} />
      ))}
    </div>
  );
}
