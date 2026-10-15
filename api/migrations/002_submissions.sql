CREATE TABLE IF NOT EXISTS submissions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title varchar(120) NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  destination varchar(120) NOT NULL DEFAULT '',
  due_date date,
  status varchar(20) NOT NULL DEFAULT 'preparing' CHECK (status IN ('preparing', 'ready', 'submitted')),
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checklist) = 'array' AND jsonb_array_length(checklist) <= 30),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS submissions_user_updated_idx
  ON submissions (user_id, updated_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS submissions_user_due_idx
  ON submissions (user_id, due_date)
  WHERE due_date IS NOT NULL;
