-- QUOXCHAT-BRUTALOOP wave 5 product P7: monthly_budget_cents / budget_action
-- were stored and never enforced because nothing tracked spend. persist-message
-- now adds each answer's LLM cost (micro-USD, integer) to the monthly bucket and
-- records which key source answered (org vault/setup key vs instance env).
ALTER TABLE widget_usage_monthly ADD COLUMN llm_cost_micro_usd INTEGER NOT NULL DEFAULT 0;
ALTER TABLE widget_usage_monthly ADD COLUMN last_key_source TEXT;
