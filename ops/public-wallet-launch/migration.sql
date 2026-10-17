BEGIN;
CREATE TABLE IF NOT EXISTS quote_admission_lock (id integer PRIMARY KEY CHECK (id=1));
INSERT INTO quote_admission_lock(id) VALUES(1) ON CONFLICT DO NOTHING;
ALTER TABLE quote_admission_lock OWNER TO telomere_mainnet;
CREATE TABLE IF NOT EXISTS workspace_documents (
  owner text PRIMARY KEY, revision integer NOT NULL CHECK(revision > 0),
  document jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE workspace_documents OWNER TO telomere_mainnet;
CREATE INDEX IF NOT EXISTS jobs_owner_created ON jobs(owner,created_at);
COMMIT;
