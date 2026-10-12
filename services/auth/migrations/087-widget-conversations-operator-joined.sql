-- QC-HOLES: staged handoff. Stamp the moment a human operator first replies
-- in a handed-off conversation. Between handoff request and this stamp the
-- AI keeps holding the visitor (gate change collector-side); after it, the
-- AI mutes and the human owns the chat. NULL = requested but not picked up.
ALTER TABLE widget_conversations ADD COLUMN operator_joined_at TEXT;
