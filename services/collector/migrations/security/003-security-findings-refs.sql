-- 003-security-findings-refs.sql -- QUOX-SECURITY finding -> next-steps
-- pipeline. Adds the two external-reference columns a finding needs once
-- it's turned into filed work: a GitHub issue ("Raise as Gripe") and a
-- QuoxPlan proposal note ("Propose as QuoxPlan"). Both nullable — a finding
-- with neither set has simply not been actioned yet, not an error state.
-- See lib/securityFindings.js (getters/setters) and
-- lib/securityReportActions.js (the actions themselves).

ALTER TABLE security_findings ADD COLUMN gripe_url TEXT;
ALTER TABLE security_findings ADD COLUMN quoxplan_ref TEXT;
