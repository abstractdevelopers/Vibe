-- Comment lifecycle: threaded replies, editing with revision history, and
-- author soft-delete with undo (§4.2 post lifecycle applied to comments).
--
-- The reply tree is capped at one level by the API, so a single nullable
-- parent_id plus an index is enough; no recursive CTE is needed to read a
-- thread.

ALTER TABLE comments ADD COLUMN parent_id uuid REFERENCES comments (id) ON DELETE CASCADE;
ALTER TABLE comments ADD COLUMN edited_at timestamptz;
ALTER TABLE comments ADD COLUMN deleted_at_prev timestamptz;

CREATE INDEX comments_parent_idx ON comments (parent_id, created_at);

-- Comment edit history, mirroring post_revisions so both lifecycles are
-- auditable in the same way rather than one being silently overwritten.
CREATE TABLE comment_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL REFERENCES comments (id) ON DELETE CASCADE,
  editor_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  previous_body text,
  new_body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX comment_revisions_comment_idx ON comment_revisions (comment_id, created_at DESC);

-- Author-deletion of a post is distinct from a moderation removal: both set
-- status='removed', so we record who deleted it. Undo is only permitted when
-- the deleter was the author, so an author can never restore content a
-- moderator removed.
ALTER TABLE posts ADD COLUMN deleted_by uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE posts ADD COLUMN deleted_at timestamptz;
