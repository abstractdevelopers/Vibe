import { useState } from "react";
import { api } from "./api";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Client-side image preparation.
 *
 * The spec asks for client-side resize/compress before upload and for uploads
 * that do not block the composer. We downscale to a sensible longest edge and
 * re-encode as JPEG so a phone photo does not arrive at full sensor size. The
 * upload itself goes through the media boundary, which returns an opaque URL.
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
  if (file.size > MAX_BYTES) throw new Error("Images must be 5 MB or smaller");
  const dataUrl = await compress(file, maxEdge);
  const result = await api<{ url: string }>("/v1/media", { body: { dataUrl } });
  return result.url;
}

export interface PendingImage {
  /** Local object URL for an instant preview. */
  preview: string;
  /** Data URL held until publish. */
  dataUrl: string;
}

export function useImageUpload() {
  const [images, setImages] = useState<PendingImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(files: FileList | File[]) {
    setError(null);
    setBusy(true);
    try {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith("image/")) {
          setError("Only images can be attached right now");
          continue;
        }
        if (file.size > MAX_BYTES) {
          setError("Images must be 5 MB or smaller");
          continue;
        }
        const dataUrl = await compress(file);
        setImages((prev) => {
          if (prev.length >= 4) return prev;
          return [...prev, { preview: dataUrl, dataUrl }];
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read that image");
    } finally {
      setBusy(false);
    }
  }

  function remove(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  /** Upload every held image and return the stored URLs. */
  async function upload(): Promise<string[]> {
    const urls: string[] = [];
    for (const image of images) {
      const result = await api<{ url: string }>("/v1/media", { body: { dataUrl: image.dataUrl } });
      urls.push(result.url);
    }
    return urls;
  }

  return { images, busy, error, add, remove, upload, setError };
}
