-- CAPTCHA / bot-detection action gate (task #127), OFF BY DEFAULT.
-- Mirrors the identity_secret pattern (migration 079): the public-safe
-- bot_protection fields (enabled/provider/site_key/min_score/guard) live in
-- embed_config_json (no migration needed — it's a JSON blob); ONLY the
-- provider secret key needs a dedicated column so it never round-trips
-- through the same JSON blob that's echoed back to the org admin's browser
-- or embedded in the widget-facing /config bootstrap response.
-- NULL (this column's default) means bot_protection is unconfigured — the
-- gate is a no-op for every existing widget with zero behaviour change.
ALTER TABLE website_widgets ADD COLUMN captcha_secret TEXT;
