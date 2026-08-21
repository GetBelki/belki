ALTER TABLE snapshots
  ADD COLUMN fan_out_telemetry_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (fan_out_telemetry_status IN ('reported', 'unavailable', 'unknown'));

UPDATE snapshots
SET fan_out_telemetry_status = CASE
  WHEN json_array_length(fan_out_queries_json) > 0 OR model IS NOT NULL
    THEN 'reported'
  ELSE 'unavailable'
END;

CREATE INDEX snapshots_fanout_telemetry_idx
  ON snapshots(fan_out_telemetry_status, model, captured_at DESC);
