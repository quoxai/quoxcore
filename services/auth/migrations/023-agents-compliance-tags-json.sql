-- REG-CORE: agent governance columns
ALTER TABLE agents ADD COLUMN compliance_tags_json TEXT DEFAULT '[]';
