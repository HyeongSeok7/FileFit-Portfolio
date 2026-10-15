ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS rule_set_id uuid REFERENCES rule_sets(id) ON DELETE SET NULL;

ALTER TABLE submissions
  ADD COLUMN IF NOT EXISTS file_name_rule varchar(240) NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS submissions_rule_set_idx
  ON submissions (rule_set_id)
  WHERE rule_set_id IS NOT NULL;
