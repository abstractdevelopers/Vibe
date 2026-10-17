import { useState } from "react";
import { api, apiUrl, getToken } from "./api";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

/** A stored media URL ends in the extension the API assigned. */
export function isVideoUrl(url: string): boolean {
  return /\.(mp4|webm|mov)(\?|$)/i.test(url);
}

/**
 * Client-side image preparation.
 *
 * We downscale to a sensible longest edge and re-encode as JPEG so a phone
 * photo does not arrive at full sensor size. Video is never read into memory or
 * base64-encoded: a clip is uploaded as raw bytes (see `uploadRawFile`), which
 * is what lets a real phone video upload at all. The old path read the whole
 * clip into a base64 data URL, which is the "could not read that file" failure.
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

/** Upload any file as raw bytes. No base64, so a large clip never inflates. */
export async function uploadRawFile(file: File): Promise<string> {
  const token = getToken();
  const res = await fetch(apiUrl("/v1/media/upload"), {
    method: "POST",
    headers: {
      "content-type": file.type || "application/octet-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: file,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error?.message ?? "Could not upload that file");
  return data.url as string;
}

export interface PendingMedia {
  /** Local preview: an object URL for video, a data URL for image. */
  preview: string;
  kind: "image" | "video";
  /** Images are held as a compressed data URL. */
  dataUrl?: string;
  /** Video is held as the original file and uploaded as raw bytes. */
  file?: File;
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
          setError("Videos must be 200 MB or smaller");
          continue;
        }
        if (isImage && file.size > MAX_IMAGE_BYTES) {
          setError("Images must be 5 MB or smaller");
          continue;
        }
        let item: PendingMedia;
        if (isVideo) {
          // Keep the file as-is; the browser can preview it from an object URL.
          item = { preview: URL.createObjectURL(file), kind: "video", file };
        } else {
          const dataUrl = await compress(file);
          item = { preview: dataUrl, kind: "image", dataUrl };
        }
        setItems((prev) => {
          // A post is either up to four photos or a single clip.
          if (prev.length >= 4) return prev;
          if (isVideo && prev.length > 0) return prev;
          if (!isVideo && prev.some((p) => p.kind === "video")) return prev;
          return [...prev, item];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that file");
    } finally {
      setBusy(false);
    }
  }

  function remove(index: number) {
    setItems((prev) => {
      const item = prev[index];
      if (item?.kind === "video") URL.revokeObjectURL(item.preview);
      return prev.filter((_, i) => i !== index);
    });
  }

  /** Upload everything held and return the stored URLs. */
  async function upload(): Promise<string[]> {
    const urls: string[] = [];
    for (const item of items) {
      if (item.kind === "video" && item.file) {
        urls.push(await uploadRawFile(item.file));
      } else if (item.dataUrl) {
        const result = await api<{ url: string }>("/v1/media", { body: { dataUrl: item.dataUrl } });
        urls.push(result.url);
      }
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
