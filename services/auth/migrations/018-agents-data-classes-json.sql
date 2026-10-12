-- REG-CORE: agent governance columns
ALTER TABLE agents ADD COLUMN data_classes_json TEXT DEFAULT '[]';
