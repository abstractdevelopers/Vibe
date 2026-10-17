-- Banner image for events.
--
-- Events could carry a title and description but no artwork, so the list and
-- detail rendered as text only. This adds one nullable column holding a media
-- path, mirroring `campaigns.creative_image_url` exactly: an absolute http(s)
-- URL or a `/v1/media/<id>` path, so the same upload endpoint and validation
-- apply. Nullable, so every existing event keeps rendering unchanged.
ALTER TABLE events ADD COLUMN image_url text
  CHECK (
    image_url IS NULL
    OR image_url ~ '^https?://'
    OR image_url ~ '^/v1/media/[A-Za-z0-9._-]+$'
  );
