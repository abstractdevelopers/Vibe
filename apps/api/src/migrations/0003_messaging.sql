-- Direct messaging.
--
-- A conversation is either a 1:1 DM or a group thread. Members are the only
-- people who can read or write it, enforced server-side. Message bodies are
-- never used for ad targeting and are not written to analytics.
--
-- Read state is a per-member watermark (last_read_at) rather than per-message
-- rows, so a conversation with a long history does not grow a read receipt row
-- per message.

CREATE TABLE conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'direct' CHECK (kind IN ('direct', 'group')),
  title text,
  created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_recent_idx ON conversations (last_message_at DESC);

CREATE TABLE conversation_members (
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_read_at timestamptz,
  muted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX conversation_members_user_idx ON conversation_members (user_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Stable client-generated id so a retry cannot duplicate a message.
  client_id text,
  body text,
  media_urls text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at DESC, id DESC);
-- One stored message per client id per sender: a replayed send is a no-op.
CREATE UNIQUE INDEX messages_client_id_idx
  ON messages (conversation_id, sender_id, client_id)
  WHERE client_id IS NOT NULL;

-- A 1:1 conversation is unique per unordered pair, so two people cannot end up
-- with two separate threads. The pair key is stored on the conversation.
ALTER TABLE conversations ADD COLUMN direct_key text;
CREATE UNIQUE INDEX conversations_direct_key_idx
  ON conversations (direct_key)
  WHERE direct_key IS NOT NULL;
