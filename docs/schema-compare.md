# Schema Compare

Open **Tools → Development → Schema Compare**. Choose a source (the desired state, for example DEV) and target (the deployment destination, for example PROD). Connections can point to different Oracle servers, or you can enter two schema names on one connection. Blank schema names use the connection user; quoted names preserve case.

Load objects, select all types or individual types, filter names, and choose individual objects. Compare up to 500 objects per run. Results distinguish identical, changed, source-only, target-only and failed comparisons. Inspect original definitions and a line diff, then select the changes to export as SQL. Download the JSON report to retain definitions, warnings and data difference samples.

Source and target connection pickers support search across connection name, schema user, host, port and service. Combine status and read-only/writable filters, sort by connection name, schema user, host, service or status, and switch ascending/descending order. Filtering leaves the selected connection and loaded comparison intact; choosing a different connection resets its schema override and requires reloading objects. Use Arrow Down from search to enter the results, arrow keys to navigate, Enter to select, and Escape to close. Source and target filters are independent.

If a selected source or target is disconnected or has a connection error, use **Connect** beneath its picker. Both connections must be connected before loading or comparing objects. The action uses the saved connection configuration and the same connection flow as Explorer. A spinner appears while connecting; setup controls are disabled until it finishes. Success updates the connection status throughout the app, and failures show the connection error with an option to retry. Source/target choices and schema overrides remain in place.

The tool only reads metadata and data. It never executes the generated deployment SQL. Saved read-only connections can be compared. Other schemas need appropriate Oracle dictionary and `DBMS_METADATA` privileges; visible objects can still have inaccessible metadata, which is reported as an error.

## Deployment scripts

Source-only objects use Oracle metadata DDL with source schema qualifiers remapped to the target. String literals and comments retain their contents; review dynamic SQL containing schema names. Changed routines, packages, views, triggers, synonyms and type bodies use replacement DDL. Supported structural types, including tables, use Oracle's SXML metadata diff to generate ALTER statements across separate connections, without creating database links or installing database objects.

Oracle metadata diff privileges, version compatibility or unsupported changes can prevent ALTER generation. These cases are marked **REVIEW** and require a manual migration; the tool does not drop and recreate existing tables as a fallback. All visible object types appear in the selection; types without supported metadata extraction (for example scheduler jobs) are explicitly reported rather than silently omitted. Database links are excluded from metadata extraction so link credentials cannot reach browser results or downloads. This is not yet full feature parity with Toad, SQL Developer or DB Solo.

Exported scripts target SQL*Plus/SQLcl script execution, disable substitution variables, set the target current schema, and stop on errors. Target-only drops and data synchronization are separate opt-in export options. ALTER statements can still remove columns or constraints: review them regardless of the target-only drop option. No rollback script is generated. Back up affected objects/data before deployment; Oracle DDL commits implicitly.

Objects are ordered by type (types/sequences before tables; specifications before bodies), with target-only drops in reverse order. This is not a full dependency sort: foreign keys, indexes associated with constraints, interdependent views, cyclic references and cross-schema references may need manual reordering, deduplication and recompilation. Re-run comparison after deployment. Grants, comments, privileges, storage and dependent objects are only included when Oracle's metadata extraction includes them; this is not a complete schema clone. Sequence DDL can differ as sequence values advance.

Oracle API reference: [Using the Metadata APIs](https://docs.oracle.com/en/database/oracle/oracle-database/19/sutil/using-oracle-dbms_metadata-api.html).

## Table data

Enable **Compare table data** before comparing. Both tables must have the same enabled primary key and matching column layouts, including lengths, numeric precision/scale, character semantics and nullability. Text, NUMBER/FLOAT, DATE, TIMESTAMP (including time zone) and RAW are supported. Numbers are fetched as canonical strings to preserve Oracle precision. LOBs, complex types, local-time-zone timestamps, identity and virtual columns are explicitly skipped. Time-zone timestamps compare their formatted local time and offset; equivalent instants with different offsets may appear different.

Each connection uses a separate read-only transaction snapshot, so changing databases are not synchronized to one global instant. By default the tool compares up to 1,000 rows per table per side (configurable up to 10,000). If either side exceeds the cap, the table is marked **limited** and no data script or equality claim is produced. It does not infer full-table results from samples.

Data details show up to 100 row differences. Optional export includes INSERT, UPDATE and DELETE statements for all differences within the limit. Review cross-table ordering, triggers, foreign keys, column length limits, character sets and changes made since the comparison. Data statements follow all DDL and require an explicit COMMIT after review. Data scripts do not include optimistic concurrency guards and should be deployed during a controlled change window. Reports and scripts contain database definitions and potentially sensitive row values; store them appropriately.

Automated tests cover generation and mocked Oracle interactions. Live Oracle metadata privileges, versions, SXML transforms and SQL*Plus execution still require integration validation against your environments.
