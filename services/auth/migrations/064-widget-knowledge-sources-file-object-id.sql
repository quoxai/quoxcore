-- CW-FU: widget_knowledge_sources ↔ file_objects
ALTER TABLE widget_knowledge_sources ADD COLUMN file_object_id TEXT REFERENCES file_objects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_knowledge_file_object ON widget_knowledge_sources(file_object_id);
