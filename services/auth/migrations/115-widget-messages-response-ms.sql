-- QUOXCHAT-BRUTALOOP wave 5 product (w5h): per-answer response time.
-- persist-message wrote the user and assistant rows with the SAME timestamp,
-- so the analytics pairing (assistant.created_at > user.created_at) found no
-- pair and avg_response_ms / response-times always had 0 samples. The
-- collector now sends the measured turn duration; it is stored on the
-- assistant row.
ALTER TABLE widget_messages ADD COLUMN response_ms INTEGER;
