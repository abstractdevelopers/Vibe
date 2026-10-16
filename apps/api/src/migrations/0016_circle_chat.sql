-- Circle chat.
--
-- A Circle is where its conversation lives: one group conversation per circle,
-- created lazily on first open and joined by every circle member. This is the
-- "conversations turn into activities" home — the chat is the circle, and plans
-- and expenses attach to the same circle.
--
-- One conversation per circle is enforced by a partial unique index rather than
-- a column default, so a circle without a chat is still valid.
ALTER TABLE conversations ADD COLUMN circle_id uuid REFERENCES circles (id) ON DELETE CASCADE;
CREATE UNIQUE INDEX conversations_circle_idx ON conversations (circle_id) WHERE circle_id IS NOT NULL;
