-- ACTIONQ-FIX-SPEC 1a — explicit action_items visibility.
--
-- Introduces visibility = 'private' | 'org' | 'scope', replacing the implicit
-- "null scope_id == org-wide" contract the UI mislabelled as "Personal".
-- Legacy rows are NOT silently made private (that would be an undisclosed
-- access change in the opposite direction — see the spec's dependency-sorted
-- rationale): a legacy null-scope row becomes visibility='org' (its actual
-- existing read contract per schema-actions.sql and the pre-existing
-- `scope_id IS NULL` list predicate), a legacy scoped row becomes
-- visibility='scope' (its actual existing contract). The UI layer separately
-- discloses legacy org-wide rows as "Organization — legacy shared task"
-- rather than presenting them as newly-private.
ALTER TABLE action_items
ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
CHECK (visibility IN ('private', 'org', 'scope'));

UPDATE action_items
SET visibility = CASE
    WHEN scope_id IS NULL THEN 'org'
    ELSE 'scope'
END;
