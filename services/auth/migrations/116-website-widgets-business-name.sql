-- QUOXCHAT-BRUTALOOP wave 6 (D4): the business name as visitors know it.
-- The persona previously guessed the brand from the widget name or the
-- crawled domain. Empty means "not set".
ALTER TABLE website_widgets ADD COLUMN business_name TEXT NOT NULL DEFAULT '';
