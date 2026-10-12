-- HV2-3: HITL columns on inbox_items
ALTER TABLE inbox_items ADD COLUMN iteration INTEGER DEFAULT 0;
ALTER TABLE inbox_items ADD COLUMN return_to_node TEXT;
