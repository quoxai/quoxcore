-- CW-8.9.2: widget completion/truth-up columns (originally an addCol()
-- helper, each call independently gated — one migration file per column).
ALTER TABLE website_widgets ADD COLUMN greeting TEXT;
