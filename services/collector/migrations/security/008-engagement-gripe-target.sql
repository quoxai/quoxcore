-- 008-engagement-gripe-target.sql -- QUOX-SECURITY: per-engagement gripe target.
-- Until now every finding raised as a GitHub issue went to a single fixed
-- repo (quoxai/quox) filed with the engagement's OWN org GitHub connector
-- token. That is correct for internal engagements but wrong for a
-- customer-site engagement: those live under an internal dev org yet must
-- file into the CUSTOMER's own repo using the CUSTOMER org's connector
-- token. This migration adds two nullable overrides on the engagement.
--
-- gripe_repo is the "owner/name" GitHub repo a finding filed from this
-- engagement goes to (null = fall back to the platform default quoxai/quox).
-- gripe_connector_org_id is the org whose GitHub connector token files it
-- (null = the engagement's own org). Together they let a customer-site
-- engagement that lives under an internal org file to the customer's repo
-- with the customer org's token. Purely additive, matching the 004/005/006/007
-- style.

ALTER TABLE security_engagements ADD COLUMN gripe_repo TEXT;
ALTER TABLE security_engagements ADD COLUMN gripe_connector_org_id TEXT;
