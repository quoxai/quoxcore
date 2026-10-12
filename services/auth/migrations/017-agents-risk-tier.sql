-- REG-CORE: agent governance columns
ALTER TABLE agents ADD COLUMN risk_tier TEXT DEFAULT 'standard';
