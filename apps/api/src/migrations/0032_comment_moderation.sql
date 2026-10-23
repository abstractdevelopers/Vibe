-- Comments record who deleted them, mirroring posts.deleted_by.
--
-- Author deletion and a moderator removal both set `deleted_at`. Without a
-- separate actor, the restore route could only check "was this the author",
-- which let a moderator-deleted comment be undone by its author. Restore is
-- now permitted only when `deleted_by` is the author (or when it is NULL, for
-- rows deleted before this migration).
ALTER TABLE comments ADD COLUMN deleted_by uuid REFERENCES users (id) ON DELETE SET NULL;

CREATE INDEX comments_deleted_by_idx ON comments (deleted_by) WHERE deleted_by IS NOT NULL;
