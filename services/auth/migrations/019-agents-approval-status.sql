-- REG-CORE: agent governance columns
ALTER TABLE agents ADD COLUMN approval_status TEXT DEFAULT 'approved';
