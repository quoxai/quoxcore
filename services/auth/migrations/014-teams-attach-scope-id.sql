-- Phase B.1: attach_scope_id on teams (nested ALTER inside the schema-b1.sql
-- guard in the original source; the schema-b1.sql CREATE TABLE content
-- itself lives in 000-baseline.sql)
ALTER TABLE teams ADD COLUMN attach_scope_id TEXT REFERENCES scopes(id);
