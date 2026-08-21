ALTER TABLE snapshots
  ADD COLUMN fan_out_telemetry_status TEXT NOT NULL DEFAULT 'unknown'
  CHECK (fan_out_telemetry_status IN ('reported', 'unavailable', 'unknown'));

UPDATE snapshots
SET fan_out_telemetry_status = CASE
  WHEN json_array_length(fan_out_queries_json) > 0 OR model IS NOT NULL
    THEN 'reported'
  ELSE 'unavailable'
END;

-- The previous Worker can continue inserting during the migration/upload
-- window. Infer its omitted status from the fields it already writes.
CREATE TRIGGER snapshots_fanout_telemetry_infer_unknown
AFTER INSERT ON snapshots
WHEN NEW.fan_out_telemetry_status = 'unknown'
BEGIN
  UPDATE snapshots
  SET fan_out_telemetry_status = CASE
    WHEN json_array_length(NEW.fan_out_queries_json) > 0 OR NEW.model IS NOT NULL
      THEN 'reported'
    ELSE 'unavailable'
  END
  WHERE id = NEW.id;
END;

CREATE INDEX snapshots_fanout_telemetry_idx
  ON snapshots(fan_out_telemetry_status, model, captured_at DESC);
