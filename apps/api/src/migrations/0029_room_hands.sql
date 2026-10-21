-- Host-controlled hand raising, and declining a raised hand.
--
-- Clubhouse lets a moderator turn hand-raising off entirely, and the audience
-- is told when it is off. Without this a host could not stop the queue filling
-- up; the only tool was to keep ignoring hands. `allow_hands` defaults true so
-- existing rooms keep behaving as they did.
ALTER TABLE activity_rooms ADD COLUMN allow_hands boolean NOT NULL DEFAULT true;
