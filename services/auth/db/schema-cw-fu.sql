-- CW-FU — QuoxChat ↔ FU adoption
-- widget_knowledge_sources now carries an optional file_object_id so uploads
-- that originate from the widget's KnowledgeTab live in the unified file
-- store instead of being parsed-and-discarded.

-- Add the column idempotently via the migration code in db/index.js
-- (sqlite doesn't support ADD COLUMN IF NOT EXISTS).
