-- QCL-IDENTITY P1: verified visitor identity (HMAC).
-- external_user_id = the customer's own stable id for the visitor, set
-- only once the host-supplied user_hash has been HMAC-verified against
-- the widget's identity_secret. verified=1 means the collector confirmed
-- HMAC-SHA256(user_id, widget.identity_secret) === user_hash; verified=0
-- (default) means any identify() attrs on this visitor are self-declared,
-- not authoritative.
ALTER TABLE widget_visitors ADD COLUMN external_user_id TEXT;
ALTER TABLE widget_visitors ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
