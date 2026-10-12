-- 073-vault-kek-bootstrap.sql
-- VAULT-AUDIT P1: bootstrap the HKDF salt + KEK version for v2 envelope
-- encryption (utils/encryption.js). These are PLAINTEXT metadata (encrypted = 0):
-- they must NEVER be flagged encrypted=1, or master-key rotation would try to
-- re-wrap them (and the salt must stay stable across rotations). randomblob(32)
-- gives a per-instance 32-byte salt; hex() stores it as a stable string.
INSERT OR IGNORE INTO instance_config (key, value, value_type, encrypted, description) VALUES
    ('vault_kek_salt', hex(randomblob(32)), 'string', 0, 'HKDF salt for vault KEK derivation (v2 envelope)'),
    ('vault_kek_version', '1', 'number', 0, 'Current vault KEK version');
