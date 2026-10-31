ALTER TABLE agent_task_queue DROP COLUMN pipeline_run_id, DROP COLUMN pipeline_job_id, DROP COLUMN pipeline_attempt;
DROP TABLE pipeline_run;
DROP TABLE pipeline_definition;
ALTER TABLE squad DROP COLUMN instructions_mode, DROP COLUMN pipeline_definition_id, DROP COLUMN revision;
