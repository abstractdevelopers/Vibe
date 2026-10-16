-- Banner creative for campaigns.
--
-- A campaign creative was text-only (0007/0008). Advertisers asked for a banner
-- image, which is the format that actually performs. This adds one nullable
-- column holding a media path.
--
-- It deliberately mirrors `users.avatar_url`'s contract: an absolute http(s)
-- URL or a `/v1/media/<id>` path, so the same upload endpoint and the same
-- validation apply, and no new upload path has to be trusted. Nullable, so
-- every existing campaign keeps rendering as text and nothing breaks.
ALTER TABLE campaigns ADD COLUMN creative_image_url text
  CHECK (
    creative_image_url IS NULL
    OR creative_image_url ~ '^https?://'
    OR creative_image_url ~ '^/v1/media/[A-Za-z0-9._-]+$'
  );
