export interface DbaPage {
  id: string;
  label: string;
  description: string;
  sections?: [string, string][];
  view?: "storage" | "memory" | "performance" | "advisor";
}
export interface DbaModule { id: string; label: string; pages: DbaPage[]; }
export const dbaModules: DbaModule[] = [
  { id: "configuration", label: "Database Configuration", pages: [
    { id: "parameters", label: "Initialization Parameters", description: "Current settings and whether Oracle permits system or PDB changes.", sections: [["parameters", "Initialization parameters"]] },
    { id: "memory", label: "Memory", description: "Inspect SGA and PGA allocation and prepare memory configuration changes.", view: "memory" },
    { id: "components", label: "Database Components", description: "Installed database components and their registry status.", sections: [["components", "Installed components"]] },
  ] },
  { id: "status", label: "Database Status", pages: [
    { id: "instance", label: "Instance & Database", description: "Instance health, startup time, database role, and current container.", sections: [["instance", "Instance"], ["database", "Database"]] },
    { id: "limits", label: "Resource Limits", description: "Current and peak resource utilization since instance startup.", sections: [["resources", "Resource limits"]] },
  ] },
  { id: "datapump", label: "Data Pump", pages: [
    { id: "datapumpJobs", label: "Data Pump Jobs", description: "Inspect Data Pump job state and attached sessions. Start exports and imports using Oracle expdp/impdp on your database tools host.", sections: [["datapump", "Data Pump jobs"]] },
    { id: "directories", label: "Directories", description: "Oracle directory objects used by Data Pump and server-side file operations.", sections: [["directories", "Directory objects"]] },
  ] },
  { id: "performance", label: "Performance", pages: [
    { id: "monitor", label: "Performance Monitor", description: "Live metrics, waits, and database activity.", view: "performance" },
    { id: "sessions", label: "Sessions", description: "User sessions, active SQL, wait events, and blocking session identifiers.", sections: [["sessions", "User sessions"]] },
  ] },
  { id: "rman", label: "RMAN Backup/Recovery", pages: [
    { id: "backups", label: "Backup Jobs", description: "Inspect RMAN backup history. Backup and restore commands must be run in an external RMAN client.", sections: [["backups", "Recent backup jobs"]] },
    { id: "recovery", label: "Recovery Area", description: "Fast recovery area allocation, consumption, and reclaimable space.", sections: [["recovery", "Recovery area"]] },
  ] },
  { id: "resourceManager", label: "Resource Manager", pages: [
    { id: "plans", label: "Resource Plans", description: "Configured Oracle resource plans and their allocation methods.", sections: [["plans", "Resource plans"]] },
    { id: "consumerGroups", label: "Consumer Groups", description: "Resource consumer groups and their CPU allocation methods.", sections: [["consumerGroups", "Consumer groups"]] },
  ] },
  { id: "translation", label: "SQL Translator Framework", pages: [
    { id: "translations", label: "Translation Profiles", description: "SQL translation profiles registered in the current database.", sections: [["translations", "Translation profiles"]] },
  ] },
  { id: "scheduler", label: "Scheduler", pages: [
    { id: "jobs", label: "Jobs", description: "Scheduler job state, schedules, next run times, and failure counts.", sections: [["jobs", "Scheduler jobs"]] },
    { id: "jobRuns", label: "Job Run History", description: "Recent execution outcomes and Oracle error details.", sections: [["jobRuns", "Recent job runs"]] },
  ] },
  { id: "security", label: "Security", pages: [
    { id: "users", label: "Users", description: "Oracle database accounts, authentication methods, and default storage.", sections: [["users", "Database users"]] },
    { id: "roles", label: "Roles & Grants", description: "Database roles and their assignments to users and other roles.", sections: [["roles", "Database roles"], ["grants", "Role grants"]] },
    { id: "profiles", label: "Profiles", description: "Password policies and resource limits assigned through Oracle profiles.", sections: [["profiles", "Profile limits"]] },
  ] },
  { id: "storage", label: "Storage", pages: [
    { id: "storage", label: "Tablespaces & Datafiles", description: "Inspect allocation and prepare tablespace and datafile changes.", view: "storage" },
    { id: "redo", label: "Redo Log Groups", description: "Online redo log group sizes, archive state, and status.", sections: [["redo", "Redo log groups"]] },
    { id: "controlfiles", label: "Control Files", description: "Control file locations and recovery destination membership.", sections: [["controlfiles", "Control files"]] },
  ] },
  { id: "tuning", label: "Tuning", pages: [
    { id: "advisor", label: "Performance Advisor", description: "Review the existing DBA performance findings and tuning indicators.", view: "advisor" },
    { id: "advisorTasks", label: "Advisor Tasks", description: "Inspect existing advisor tasks and completion status.", sections: [["advisorTasks", "Advisor tasks"]] },
  ] },
];
