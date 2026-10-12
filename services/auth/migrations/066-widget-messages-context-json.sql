-- QCX-5a: full LLM input context for admin LogsTab
ALTER TABLE widget_messages ADD COLUMN context_json TEXT;
