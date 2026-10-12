-- QCX-6c: per-widget retention override (days)
ALTER TABLE website_widgets ADD COLUMN retention_days_override INTEGER;
