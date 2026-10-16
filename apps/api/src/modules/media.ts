import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import { parse, requireUser, type AppContext } from "../http.js";

/**
 * Media boundary.
 *
 * The spec calls for S3-compatible object storage with short-lived signed
 * uploads and access-controlled downloads. That provider is not chosen yet, so
 * this module defines the boundary and ships a local-disk stub that behaves the
 * same way to callers: an authenticated upload returns an opaque id, and reads
 * go through a URL the client does not have to understand. Swapping in a real
 * bucket means reimplementing `MediaStore`, not touching the routes.
 */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB per image, matching the client-side cap.
const MAX_VIDEO_BYTES = 25 * 1024 * 1024; // 25 MB per clip; a signed-URL flow lifts this.
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const VIDEO_TYPES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
const ALLOWED = new Set([...IMAGE_TYPES, ...VIDEO_TYPES]);

/** Extension per MIME type, so a stored file round-trips its content type. */
const EXT_FOR_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};
const TYPE_FOR_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_FOR_TYPE).map(([type, ext]) => [ext, type]),
);

const dataDir = resolve(
  process.env.MEDIA_DIR ?? join(dirname(fileURLToPath(import.meta.url)), "../../.data/media"),
);

const uploadSchema = z.object({
  // A data URL keeps the boundary dependency-free. A signed-URL flow replaces
  // this without changing the client contract.
  dataUrl: z.string().min(32).max(8 * 1024 * 1024),
});

interface StoredMedia {
  id: string;
  contentType: string;
  bytes: Buffer;
}

export interface MediaStore {
  put(input: { contentType: string; bytes: Buffer }): Promise<{ id: string; url: string }>;
  get(id: string): Promise<StoredMedia | null>;
}

/** Local-disk store. Durable only if MEDIA_DIR points at a mounted volume. */
class DiskMediaStore implements MediaStore {
  async put({ contentType, bytes }: { contentType: string; bytes: Buffer }) {
    const ext = EXT_FOR_TYPE[contentType] ?? "bin";
    const id = `${randomBytes(12).toString("hex")}.${ext}`;
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, id), bytes);
    return { id, url: `/v1/media/${id}` };
  }

  async get(id: string) {
    // Reject anything that could escape the media directory.
    if (!/^[a-f0-9]{24}\.[a-z0-9]{3,4}$/.test(id)) return null;
    const path = join(dataDir, id);
    if (!existsSync(path)) return null;
    const ext = id.split(".")[1] ?? "jpg";
    const contentType = TYPE_FOR_EXT[ext] ?? "application/octet-stream";
    return { id, contentType, bytes: await readFile(path) };
  }
}

const store: MediaStore = new DiskMediaStore();

function decodeDataUrl(dataUrl: string): { contentType: string; bytes: Buffer } {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw ApiError.badRequest("Expected a base64 data URL");
  const contentType = match[1]!;
  const payload = match[2]!;
  if (!ALLOWED.has(contentType)) {
    throw ApiError.badRequest("Only JPEG, PNG, WebP, GIF images and MP4, WebM, MOV videos are supported");
  }
  const isVideo = VIDEO_TYPES.has(contentType);
  const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const bytes = Buffer.from(payload, "base64");
  if (bytes.length === 0) throw ApiError.badRequest(isVideo ? "The video is empty" : "The image is empty");
  if (bytes.length > limit) {
    throw ApiError.badRequest(
      isVideo ? "Videos must be 25 MB or smaller" : "Images must be 5 MB or smaller",
    );
  }
  return { contentType, bytes };
}

export function mediaRoutes(ctx: AppContext) {
  return async function register(app: FastifyInstance): Promise<void> {
    app.post(
      "/v1/media",
      // Base64 inflates by ~4/3, so the body limit has to clear the decoded
      // video cap (25 MB -> ~34 MB) plus the data-URL prefix.
      { bodyLimit: 40 * 1024 * 1024 },
      async (req, reply) => {
        await requireUser(ctx, req);
        const input = parse(uploadSchema, req.body);
        const { contentType, bytes } = decodeDataUrl(input.dataUrl);
        const stored = await store.put({ contentType, bytes });
        reply.code(201);
        return { id: stored.id, url: stored.url, contentType };
      },
    );

    app.get("/v1/media/:id", async (req, reply) => {
      const { id } = req.params as { id: string };
      const media = await store.get(id);
      if (!media) throw ApiError.notFound("Media not found");
      reply.header("content-type", media.contentType);
      reply.header("cache-control", "public, max-age=31536000, immutable");
      // Video needs range requests to seek; the disk store serves the whole
      // body, which every browser accepts for a small clip.
      reply.header("accept-ranges", "bytes");
      return reply.send(media.bytes);
    });
  };
}
