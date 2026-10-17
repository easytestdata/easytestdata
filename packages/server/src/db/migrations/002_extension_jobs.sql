-- Extension jobs: rows a server extension creates (enqueueExtensionJob) and the shared runner
-- runs in the QuickBooks lane. config = { extension, kind, payload }. They count toward the
-- one-active-QuickBooks-job-per-team rule like loads, purges and rollbacks.
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check
  CHECK (type IN ('generate', 'load', 'purge', 'export', 'rollback', 'extension'));

DROP INDEX jobs_one_active_qbo_job_per_team;
CREATE UNIQUE INDEX jobs_one_active_qbo_job_per_team ON jobs (team_id)
  WHERE type IN ('load', 'purge', 'rollback', 'extension')
    AND status IN ('pending', 'running', 'cancelling');
