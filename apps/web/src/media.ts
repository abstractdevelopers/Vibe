import { useState } from "react";
import { api } from "./api";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;

/** A stored media URL ends in the extension the API assigned. */
export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/**
 * Client-side image preparation.
 *
 * The spec asks for client-side resize/compress before upload and for uploads
 * that do not block the composer. We downscale to a sensible longest edge and
 * re-encode as JPEG so a phone photo does not arrive at full sensor size. The
 * upload itself goes through the media boundary, which returns an opaque URL.
 *
 * Video is deliberately not re-encoded here: a browser cannot transcode without
 * a WASM codec, which is not worth the bundle. A clip is size-capped and sent
 * as-is; a signed-URL direct-to-bucket flow is the real answer once a provider
 * is chosen.
 */
async function compress(file: File, maxEdge = 1600): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas is unavailable in this browser");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

/**
 * Compress and upload a single image immediately, returning its stored URL.
 * Used where an upload should not wait for a publish step, such as an avatar.
 */
export async function uploadImageFile(file: File, maxEdge = 512): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Only images can be uploaded");
  if (file.size > MAX_IMAGE_BYTES) throw new Error("Images must be 5 MB or smaller");
  const dataUrl = await compress(file, maxEdge);
  const result = await api<{ url: string }>("/v1/media", { body: { dataUrl } });
  return result.url;
}

export interface PendingMedia {
  /** Local preview source: a data URL for images, an object URL for video. */
  preview: string;
  /** Payload held until publish. */
  dataUrl: string;
  kind: "image" | "video";
}

export function useMediaUpload() {
  const [items, setItems] = useState<PendingMedia[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(files: FileList | File[]) {
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        const isVideo = file.type.startsWith("video/");
        const isImage = file.type.startsWith("image/");
        if (!isVideo && !isImage) {
          setError("Only photos and videos can be attached");
          continue;
        }
        if (isVideo && file.size > MAX_VIDEO_BYTES) {
          setError("Videos must be 25 MB or smaller");
          continue;
        }
        if (isImage && file.size > MAX_IMAGE_BYTES) {
          setError("Images must be 5 MB or smaller");
          continue;
        }
        const dataUrl = isVideo ? await readAsDataUrl(file) : await compress(file);
        setItems((prev) => {
          // A post is either up to four photos or a single clip.
          if (prev.length >= 4) return prev;
          if (isVideo && prev.length > 0) return prev;
          if (!isVideo && prev.some((p) => p.kind === "video")) return prev;
          return [...prev, { preview: dataUrl, dataUrl, kind: isVideo ? "video" : "image" }];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file");
    } finally {
      setBusy(false);
    }
  }

  function remove(index: number) {
    setItems((prev) => prev.filter((_, i) => i !== index));
  }

  /** Upload everything held and return the stored URLs. */
  async function upload(): Promise<string[]> {
    const urls: string[] = [];
    for (const item of items) {
      const result = await api<{ url: string }>("/v1/media", { body: { dataUrl: item.dataUrl } });
      urls.push(result.url);
    }
    return urls;
  }

  return {
    items,
    busy,
    error,
    add,
    remove,
    upload,
    setError,
    hasVideo: items.some((i) => i.kind === "video"),
  };
}
