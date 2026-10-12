-- AUD-WS-1: time-bounded org memberships (auditor invites)
ALTER TABLE org_memberships ADD COLUMN expires_at TEXT;
