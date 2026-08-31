-- A platform identifier describes where a response was captured, not which
-- underlying model generated it. Preserve only provider-reported model names.
UPDATE snapshots
SET model = NULL
WHERE lower(trim(model)) IN (
  'chatgpt', 'gemini', 'google_ai_mode', 'google ai mode',
  'google_ai_overview', 'google ai overview', 'google ai overviews'
);
