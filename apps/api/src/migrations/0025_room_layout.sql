-- Room layout: how a voice/listen room presents itself.
--
-- 'stage' is the original open-mic shape: every speaker connects to every other
-- speaker in a WebRTC mesh, which is great for a handful of people talking.
-- 'broadcast' is one-to-many: only the host publishes audio and every listener
-- connects to the host alone, so the room can carry far more listeners than a
-- mesh before it needs a real media server (SFU). It is still peer-to-peer, and
-- still bounded by the host's uplink — this is the honest ceiling, not a claim of
-- unlimited scale.
ALTER TABLE activity_rooms ADD COLUMN layout text NOT NULL DEFAULT 'stage'
  CHECK (layout IN ('stage', 'broadcast'));
