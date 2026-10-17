-- Per-kind room features.
--
-- A sports room is a scoreboard, and a scoreboard without a source is a rumour.
-- The score row therefore requires a named source, and the API refuses to write
-- one without it — the same "cite it or do not say it" rule the room creation
-- already applies to data sources.
--
-- A listen/music room is a queue. `audio_queue` holds the upcoming tracks; the
-- current one stays in the existing `audio_track` column so nothing else changes.
CREATE TABLE room_scores (
  room_id uuid PRIMARY KEY REFERENCES activity_rooms (id) ON DELETE CASCADE,
  home_label text NOT NULL,
  away_label text NOT NULL,
  home_score integer NOT NULL DEFAULT 0,
  away_score integer NOT NULL DEFAULT 0,
  minute text,
  source_name text NOT NULL,
  source_url text,
  updated_by uuid REFERENCES users (id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE activity_rooms ADD COLUMN audio_queue jsonb NOT NULL DEFAULT '[]'::jsonb;
