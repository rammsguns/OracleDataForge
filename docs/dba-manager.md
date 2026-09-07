# DBA Manager

## Change audit

`data/dba-audit.jsonl` is an append-only application log. The server writes and flushes an attempt before executing a storage change; if that write fails, execution is blocked. A second record reports the result using the same audit ID, UTC timestamp, authenticated actor, database user, connection, operation, target, and generated SQL. The editor shows recent audit records and refreshes them after applying changes. A failed completion write is reported explicitly; check the database before retrying. An attempt without an outcome can indicate interruption or an uncertain result.

Worksheet writes, including DBA memory statements, also record attempts and outcomes. They retain operation/target metadata and a SHA-256 SQL digest instead of arbitrary SQL text, which may contain credentials or data. Other management endpoints and changes made outside DataForge are not covered. Use Oracle auditing for database-wide coverage. The local log is not tamper-proof: administrators should protect and back up the data directory and archive the log according to their retention policy. The UI reads the most recent 1 MiB and displays up to 100 matching records; the underlying log is not truncated.

Open **DBA Manager** from the workspace launchers. Its connection tree follows the SQL Developer DBA navigator, with eleven expandable modules and 24 child pages. Select a connection, expand a module, and choose a page. Search narrows modules by category or child-page name. Administrator and Developer app roles can access the module; Oracle grants determine which data and operations are available.

| Module | Pages |
| --- | --- |
| Database Configuration | Initialization Parameters, Memory, Database Components |
| Database Status | Instance & Database, Resource Limits |
| Data Pump | Data Pump Jobs, Directories |
| Performance | Performance Monitor, Sessions |
| RMAN Backup/Recovery | Backup Jobs, Recovery Area |
| Resource Manager | Resource Plans, Consumer Groups |
| SQL Translator Framework | Translation Profiles |
| Scheduler | Jobs, Job Run History |
| Security | Users, Roles & Grants, Profiles |
| Storage | Tablespaces & Datafiles, Redo Log Groups, Control Files |
| Tuning | Performance Advisor, Advisor Tasks |

Storage supports creation, adding/resizing files, automatic growth limits, read-only/read-write mode, and deletion with explicit review and confirmation. Database Configuration → Memory retains memory changes with MEMORY, SPFILE, or BOTH scope. Performance Monitor and Performance Advisor reuse the existing dashboards. Other pages provide catalog inspection, refresh, and filtering of loaded rows. Data Pump exports/imports use external expdp/impdp tools; RMAN backup/restore execution uses an external RMAN client. These pages inspect existing jobs and configuration, without starting jobs or restores.

For storage, select the tablespace/file, edit settings, choose **Review SQL**, then **Confirm and apply**. A confirmation dialog identifies the connection, exact SQL, and consequences. Successful changes refresh storage automatically. Deletion requires typing the exact tablespace name and keeps physical files unless their deletion is explicitly selected. SYSTEM and SYSAUX deletion is blocked. Memory changes use **Review SQL**, then **Open in worksheet**, followed by the worksheet confirmation. Read-only connections disable changes.

The read endpoint accepts an optional `sections` query parameter containing one to six allowlisted section names. Only the selected page's views are queried, sequentially on one Oracle session. Each query returns at most 500 rows with an explicit truncation notice; filters apply to loaded rows. Recent job and backup history is ordered newest first. Each failed query displays its Oracle error independently. Missing privileges and database-version/container differences do not prevent browsing other pages. Switching connection or page discards pending UI responses from the previous selection.

New files default to AUTOEXTEND OFF. Additional files are not supported for bigfile tablespaces. File paths refer to the database server, not the browser machine. Oracle checks storage limits and whether a file can shrink. SPFILE/BOTH requires an SPFILE; static memory parameters require restart. PDB changes and memory combinations remain subject to Oracle restrictions. No automatic restart is performed.

Oracle references: [ALTER TABLESPACE](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqlrf/ALTER-TABLESPACE.html) and [ALTER SYSTEM](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/ALTER-SYSTEM.html).

### Tablespace capacity dashboard

Storage now includes searchable tablespaces, health filters, urgency/remaining-capacity sorting, usage bars, and selected-tablespace file actions. Warning begins at 85% used; critical begins at 95%. Missing metrics are Unknown, never healthy. Capacity and used bytes come from DBA_TABLESPACE_USAGE_METRICS joined to DBA_TABLESPACES for block size. Capacity includes Oracle-reported potential autoextend growth and underlying storage constraints; it is not currently allocated free space. Shared capacity is not summed. Undo metrics include expired undo. Datafile allocation and configured maximum remain visible separately. Queries and row limits are independent; partial snapshots are labeled.

Contextual file and tablespace shortcuts prefill the direct edit form. Resize starts with the current file size and asks for the new total size. Bigfile tablespaces disable Add file; temporary tablespaces preselect tempfile operations. Read-only connections disable management shortcuts.

Oracle metric semantics: https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/DBA_TABLESPACE_USAGE_METRICS.html


