-- LIFECYCLE-P4-D1: trust_tier ('untrusted' | 'community' | 'verified')
ALTER TABLE tool_definitions ADD COLUMN trust_tier TEXT DEFAULT 'community';
