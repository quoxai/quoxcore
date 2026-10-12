-- QUOXCHAT-PRO P1 — org-configurable alerts + availability for QuoxChat.
--
-- notification_settings_json: per-widget alerting config read by the
--   collector's /quoxchat/message notification emit (new_conversation /
--   handoff_requested events, email + webhook channels via
--   notificationService). Server-side only — never exposed through the
--   widget-facing /quoxchat/config/:publicKey response (it can contain
--   operator email addresses and webhook URLs). Shape:
--     { "new_conversation":  { "enabled": true, "channels": [
--         { "type": "email",   "to": "ops@example.com" },
--         { "type": "webhook", "url": "https://...", "secret": "..." } ] },
--       "handoff_requested": { ... same shape ... } }
--   NULL (default) = alerting off, zero behaviour change for existing widgets.
--
-- office_hours_json: human availability schedule. Evaluated collector-side
--   (lib/quoxchatOfficeHours.js) into a public human_available boolean on
--   the widget config response. Shape:
--     { "timezone": "Europe/London",
--       "hours": { "mon": [["09:00","17:00"]], ... "sun": [] } }
--   NULL (default) = no schedule, humans considered available at all times.
--
-- operator_online: manual toggle (org admin). 1 = online (default, no
--   behaviour change), 0 = offline — the widget shows the "humans are
--   offline, AI keeps answering" banner for handoff expectations.
ALTER TABLE website_widgets ADD COLUMN notification_settings_json TEXT;
ALTER TABLE website_widgets ADD COLUMN office_hours_json TEXT;
ALTER TABLE website_widgets ADD COLUMN operator_online INTEGER NOT NULL DEFAULT 1;
