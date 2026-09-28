export const managementQueries = {
  tablespaceUsage: `SELECT t.tablespace_name AS "Name", m.used_space*t.block_size/1048576 AS "Used MiB", m.tablespace_size*t.block_size/1048576 AS "Capacity MiB" FROM dba_tablespaces t LEFT JOIN dba_tablespace_usage_metrics m ON m.tablespace_name=t.tablespace_name ORDER BY m.used_percent DESC NULLS FIRST, t.tablespace_name`,
  parameters: `SELECT name AS "Parameter", display_value AS "Value", isdefault AS "Default", issys_modifiable AS "System modifiable", ispdb_modifiable AS "PDB modifiable" FROM v$system_parameter ORDER BY name`,
  instance: `SELECT instance_name AS "Instance", host_name AS "Host", version AS "Version", status AS "Status", database_status AS "Database status", TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') AS "Started" FROM v$instance`,
  database: `SELECT name AS "Database", open_mode AS "Open mode", database_role AS "Role", log_mode AS "Log mode", protection_mode AS "Protection mode", SYS_CONTEXT('USERENV','CON_NAME') AS "Container" FROM v$database`,
  components: `SELECT comp_name AS "Component", version AS "Version", status AS "Status" FROM dba_registry ORDER BY comp_name`,
  datapump: `SELECT owner_name AS "Owner", job_name AS "Job", operation AS "Operation", job_mode AS "Mode", state AS "State", degree AS "Degree", attached_sessions AS "Attached sessions" FROM dba_datapump_jobs ORDER BY owner_name, job_name`,
  directories: `SELECT owner AS "Owner", directory_name AS "Directory", directory_path AS "Server path" FROM dba_directories ORDER BY directory_name`,
  sessions: `SELECT sid AS "SID", serial# AS "Serial", username AS "User", status AS "Status", machine AS "Machine", program AS "Program", sql_id AS "SQL ID", event AS "Event", blocking_session AS "Blocking SID" FROM v$session WHERE type = 'USER' ORDER BY status, sid`,
  backups: `SELECT session_key AS "Session", input_type AS "Type", status AS "Status", TO_CHAR(start_time,'YYYY-MM-DD HH24:MI:SS') AS "Started", TO_CHAR(end_time,'YYYY-MM-DD HH24:MI:SS') AS "Finished", input_bytes_display AS "Input", output_bytes_display AS "Output", output_device_type AS "Device" FROM v$rman_backup_job_details ORDER BY start_time DESC`,
  recovery: `SELECT name AS "Destination", ROUND(space_limit/1048576,2) AS "Limit MiB", ROUND(space_used/1048576,2) AS "Used MiB", ROUND(space_reclaimable/1048576,2) AS "Reclaimable MiB", number_of_files AS "Files" FROM v$recovery_file_dest`,
  plans: `SELECT plan AS "Plan", status AS "Status", cpu_method AS "CPU method", num_plan_directives AS "Directives", comments AS "Comments" FROM dba_rsrc_plans ORDER BY plan`,
  consumerGroups: `SELECT consumer_group AS "Consumer group", cpu_method AS "CPU method", comments AS "Comments" FROM dba_rsrc_consumer_groups ORDER BY consumer_group`,
  translations: `SELECT owner AS "Owner", profile_name AS "Profile", translator AS "Translator" FROM dba_sql_translation_profiles ORDER BY owner, profile_name`,
  jobs: `SELECT owner AS "Owner", job_name AS "Job", enabled AS "Enabled", state AS "State", job_type AS "Type", repeat_interval AS "Repeat interval", TO_CHAR(next_run_date,'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS "Next run", failure_count AS "Failures" FROM dba_scheduler_jobs ORDER BY owner, job_name`,
  jobRuns: `SELECT owner AS "Owner", job_name AS "Job", status AS "Status", TO_CHAR(log_date,'YYYY-MM-DD HH24:MI:SS TZH:TZM') AS "Logged", error# AS "Error", additional_info AS "Details" FROM dba_scheduler_job_run_details ORDER BY log_date DESC`,
  users: `SELECT username AS "User", account_status AS "Status", default_tablespace AS "Default tablespace", temporary_tablespace AS "Temporary tablespace", profile AS "Profile", authentication_type AS "Authentication" FROM dba_users ORDER BY username`,
  roles: `SELECT role AS "Role", authentication_type AS "Authentication" FROM dba_roles ORDER BY role`,
  grants: `SELECT grantee AS "Grantee", granted_role AS "Role", admin_option AS "Admin option", default_role AS "Default role" FROM dba_role_privs ORDER BY grantee, granted_role`,
  profiles: `SELECT profile AS "Profile", resource_name AS "Resource", resource_type AS "Type", limit AS "Limit" FROM dba_profiles ORDER BY profile, resource_name`,
  redo: `SELECT group# AS "Group", thread# AS "Thread", sequence# AS "Sequence", ROUND(bytes/1048576,2) AS "MiB", members AS "Members", archived AS "Archived", status AS "Status" FROM v$log ORDER BY group#`,
  controlfiles: `SELECT name AS "File", status AS "Status", is_recovery_dest_file AS "In recovery destination" FROM v$controlfile ORDER BY name`,
  advisorTasks: `SELECT owner AS "Owner", task_name AS "Task", advisor_name AS "Advisor", status AS "Status", TO_CHAR(created,'YYYY-MM-DD HH24:MI:SS') AS "Created" FROM dba_advisor_tasks ORDER BY created DESC`,
  tablespaces: `SELECT tablespace_name AS "Name", contents AS "Contents", status AS "Status", bigfile AS "Bigfile", block_size AS "Block bytes", extent_management AS "Extent management" FROM dba_tablespaces ORDER BY tablespace_name`,
  files: `SELECT tablespace_name AS "Tablespace", file_name AS "File", 'DATAFILE' AS "Kind", ROUND(bytes/1048576,2) AS "Allocated MiB", autoextensible AS "Autoextend", ROUND(maxbytes/1048576,2) AS "Max MiB" FROM dba_data_files UNION ALL SELECT tablespace_name, file_name, 'TEMPFILE', ROUND(bytes/1048576,2), autoextensible, ROUND(maxbytes/1048576,2) FROM dba_temp_files ORDER BY 1,2`,
  memory: `SELECT name AS "Parameter", display_value AS "Value", issys_modifiable AS "System modifiable", ispdb_modifiable AS "PDB modifiable" FROM v$system_parameter WHERE name IN ('memory_target','memory_max_target','sga_target','sga_max_size','pga_aggregate_target','pga_aggregate_limit','db_cache_size','shared_pool_size') ORDER BY name`,
  sga: `SELECT name AS "Component", ROUND(value/1048576,2) AS "MiB" FROM v$sga ORDER BY name`,
  pga: `SELECT name AS "Statistic", value AS "Value", unit AS "Unit" FROM v$pgastat ORDER BY name`,
  resources: `SELECT resource_name AS "Resource", current_utilization AS "Current", max_utilization AS "Peak", initial_allocation AS "Initial allocation", limit_value AS "Limit" FROM v$resource_limit ORDER BY resource_name`,
};

export function selectManagementQueries(value: unknown) {
  const names = value === undefined ? ["tablespaces", "files", "memory", "sga", "pga", "resources"] : typeof value === "string" ? value.split(",") : [];
  if (!names.length || names.length > 6 || names.some(name => !Object.hasOwn(managementQueries, name))) throw new Error("Select between one and six valid DBA sections.");
  return [...new Set(names)].map(name => [name, managementQueries[name as keyof typeof managementQueries]] as const);
}
