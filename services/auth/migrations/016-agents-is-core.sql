-- REG-CORE: agent governance columns (originally a JS loop with a
-- try/catch PER statement — each column is independently idempotent, so
-- each is its own migration file here, matching that exact semantics).
ALTER TABLE agents ADD COLUMN is_core INTEGER DEFAULT 0;
