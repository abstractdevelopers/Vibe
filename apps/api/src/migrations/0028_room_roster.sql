-- Room roster controls: a host can remove someone from the room, and can mute
-- everyone on the stage at once. Both are recorded in the moderation trail, so
-- the allow-list of actions has to grow with them.
ALTER TABLE room_moderation_actions DROP CONSTRAINT room_moderation_actions_action_check;
ALTER TABLE room_moderation_actions ADD CONSTRAINT room_moderation_actions_action_check
  CHECK (action IN ('remove_post', 'slow_mode', 'close_room', 'reopen_room', 'kick', 'mute_all'));
