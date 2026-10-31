CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS pipeline_task ON agent_task_queue (pipeline_run_id, pipeline_job_id, pipeline_attempt) WHERE pipeline_run_id IS NOT NULL;
