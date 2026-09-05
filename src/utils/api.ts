/** Thin client for the local Oracle DataForge backend. */

/**
 * How a connection reaches Oracle: `basic` is host/port/service over TCP, `wallet` is an
 * Oracle Cloud wallet (mutual TLS to Autonomous Database), where the endpoint comes from
 * the wallet's tnsnames.ora and `database` names the service alias inside it.
 */
export type AuthMode = "basic" | "wallet";

/**
 * The Oracle administrative privilege a connection opens its sessions with — SQL Developer's
 * "Role" dropdown. `default` is an ordinary session; the rest are password-file privileges,
 * and are how accounts like SYS or an RMAN backup user connect at all.
 */
export type ConnectionRole = "default" | "SYSDBA" | "SYSOPER" | "SYSBACKUP" | "SYSDG" | "SYSKM" | "SYSASM";

/** Every role the connection form offers, in SQL Developer's order. */
export const CONNECTION_ROLES: ConnectionRole[] = ["default", "SYSDBA", "SYSOPER", "SYSBACKUP", "SYSDG", "SYSKM", "SYSASM"];

export interface LiveConnConfig {
  name: string;
  engine: "oracle";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  readOnly?: boolean;
  role?: ConnectionRole;
  authMode?: AuthMode;
  /** wallet mode: the wallet uploaded through `uploadWallet` */
  walletId?: string;
  /** wallet mode: the password its PEM key is encrypted with; blank keeps the saved one */
  walletPassword?: string;
}

/** A saved connection as the backend reports it — metadata only, never a password. */
export interface StoredConnection {
  id: string;
  name: string;
  engine: "oracle";
  host: string;
  port: number;
  user: string;
  database: string;
  readOnly: boolean;
  role?: ConnectionRole;
  authMode?: AuthMode;
  walletId?: string;
}

/** One service from a wallet's tnsnames.ora — an alias and where it points. */
export interface WalletService {
  alias: string;
  host: string;
  port: number;
  serviceName: string;
}

/** What the backend answers with after unpacking an uploaded wallet zip. */
export interface WalletInfo {
  walletId: string;
  services: WalletService[];
  /** the PEM inside is encrypted, so connecting needs the wallet password */
  needsPassword: boolean;
}


/**
 * A passphrase-encrypted connection export, exactly as it is written to disk. The
 * connections — Oracle passwords included — live inside `data`, encrypted under a key the
 * server derives from the user's passphrase with scrypt; nothing readable ever reaches
 * the browser. See docs/credentials.md for how to decrypt one outside the app.
 */
export interface ConnectionExportFile {
  format: "oracle-dataforge-connections";
  version: 1;
  exportedAt: string;
  count: number;
  cipher: "aes-256-gcm";
  kdf: { name: "scrypt"; salt: string; N: number; r: number; p: number; keylen: number };
  iv: string;
  tag: string;
  data: string;
}

/** One connection inside an uploaded export, as the preview describes it — no password. */
export interface ImportPreviewEntry {
  index: number;
  name: string;
  host: string;
  port: number;
  user: string;
  database: string;
  readOnly: boolean;
  /** the privilege it connects with, so an `AS SYSDBA` import is visible before it lands */
  role?: ConnectionRole;
  /** `wallet` entries bring the Oracle Cloud wallet with them, inside the encrypted file */
  authMode?: AuthMode;
  /** set when this entry cannot be imported at all (e.g. no service name) */
  error?: string;
  /** set when a saved connection already points at the same server, port, user and service */
  duplicateOfId?: string;
  duplicateOfName?: string;
}

export interface ImportPreview {
  exportedAt: string;
  entries: ImportPreviewEntry[];
}

/** What an import did, by connection name, so the UI can say it rather than guess. */
export interface ConnectionImportResult {
  added: string[];
  replaced: string[];
  skipped: string[];
}
export interface TestResult {
  ok: boolean;
  version?: string;
  ms?: number;
  error?: string;
}

/** Result of closing the pooled sessions of a connection. */
export interface DisconnectResult {
  ok: boolean;
  /** false when nothing was open — the connection was already disconnected */
  wasOpen: boolean;
}

export interface LiveSchema {
  schemaName: string;
  tables: { name: string; rowCount: number }[];
  views: string[];
  /** additional object categories (procedures, packages, jobs, …) */
  extras?: { label: string; kind: string; items: string[]; invalid?: string[] }[];
  /** Oracle: `[]` — a table is never INVALID, but saying so marks the group as *checked* */
  invalidTables?: string[];
  /** Oracle: views the dictionary reports as INVALID */
  invalidViews?: string[];
}

/** One schema-tree group, re-read on its own — `GET /:id/schema/group`. */
export interface SchemaGroupResult {
  label: string;
  kind: string;
  items: string[];
  /** names reported INVALID (UNUSABLE for indexes). */
  invalid?: string[];
  /** Tables only */
  rowCounts?: Record<string, number>;
}

export interface DbaMetric { name: string; value: number; unit: string; }
export interface DbaWaitEvent { event: string; waits: number; timeS: number; avgMs: number; waitClass: string; }
export interface DbaTopSql { sqlId: string; elapsedS: number; executions: number; perExecMs: number; sqlText: string; }
export interface DbaTablespace { name: string; usedMb: number; totalMb: number; pct: number; }
export interface DbaNameMb { name: string; mb: number; }
export interface DbaAdvice { severity: "good" | "warning" | "serious" | "critical"; title: string; detail: string; }

export interface DbaReport {
  available: boolean;
  privilegeHint?: string;
  instance: { name: string; version: string; status: string; startup: string; host: string; dbName: string; openMode: string } | null;
  metrics: DbaMetric[];
  waitEvents: DbaWaitEvent[];
  topSql: DbaTopSql[];
  tablespaces: DbaTablespace[];
  sessions: { active: number; inactive: number; total: number; users: { user: string; cnt: number }[] };
  sga: DbaNameMb[];
  pga: DbaNameMb[];
  advice: DbaAdvice[];
}

export interface PerfReport {
  engine: "oracle";
  scope: string;
  tiles: { label: string; value: string; sub?: string; tone?: "ok" | "warn" | "err" }[];
  series?: { label: string; unit: string; points: { t: string; v: number }[] };
  slowQueries: { sql: string; avgMs: number; execs: number; totalS: number }[];
  sessions: { id: string; user: string; program: string; status: string; event: string; seconds: number }[];
  storage: { name: string; usedMb: number; totalMb: number | null }[];
  activity: { at: string; text: string; kind: "ok" | "info" | "err" }[];
  note?: string;
}

export interface DepItem {
  owner?: string;
  name: string;
  type: string;
  /** how the dependency was detected, e.g. "FK ORDERS_CUST_FK" or "text match" */
  via?: string;
  status?: string;
}

export interface DepsReport {
  engine: "oracle";
  object: { name: string; type: string; status?: string } | null;
  uses: DepItem[];
  usedBy: DepItem[];
  impact: (DepItem & { level: number; path: string })[];
  note?: string;
}

export interface ErdColumn { name: string; type: string; pk: boolean; fk: boolean; nullable: boolean; }
export interface ErdTable { name: string; rowCount: number | null; columns: ErdColumn[]; }
export interface ErdRelationship { name: string; fromTable: string; fromColumns: string[]; toTable: string; toColumns: string[]; }
export interface ErdResult {
  engine: "oracle";
  schema: string;
  tables: ErdTable[];
  relationships: ErdRelationship[];
  truncated: boolean;
  /** Oracle index/mview internals left out of the model — reported so the omission is visible */
  hiddenSystem?: number;
}

/* ---- Routine runner (Oracle) ---- */

export type RoutineBindKind = "number" | "string" | "date" | "boolean" | "cursor";
export type RoutineDirection = "IN" | "OUT" | "IN/OUT";

export interface RoutineParam {
  name: string;
  position: number;
  dataType: string;
  direction: RoutineDirection;
  hasDefault: boolean;
  /** null = the type cannot be bound (record/collection/object) — the form disables Run and
   *  says why; the PL/SQL block editor can still build the value by hand */
  bindKind: RoutineBindKind | null;
  /** how to DECLARE this parameter in a hand-written block (composite types included) */
  declType: string;
}

export interface RoutineMember {
  name: string;
  kind: "PROCEDURE" | "FUNCTION";
  overload: string | null;
  params: RoutineParam[];
  returnType: string | null;
  returnBindKind: RoutineBindKind | null;
  returnDeclType: string | null;
}

export interface RoutineMeta {
  name: string;
  type: "PROCEDURE" | "FUNCTION" | "PACKAGE";
  members: RoutineMember[];
  error?: string;
}

export interface RoutineArgInput {
  name: string;
  /** text value converted server-side by the declared type; null = NULL */
  value: string | null;
  /** omit the parameter from the call so its declared DEFAULT applies */
  useDefault?: boolean;
}

export interface RoutineRunRequest {
  name: string;
  member?: string;
  overload?: string | null;
  args: RoutineArgInput[];
  /** hand-written anonymous block; when present it runs verbatim and `args` is ignored */
  block?: string;
}

export interface RoutineCursor {
  name: string;
  columns: string[];
  rows: (string | number | null)[][];
  truncated: boolean;
}

export interface RoutineRunResult {
  ok: boolean;
  durationMs: number;
  /** the anonymous block that actually ran */
  block: string;
  /** "form" = generated from the parameter grid's typed binds, "block" = the user's own text */
  source: "form" | "block";
  member: string;
  returnValue?: string | number | null;
  outParams: { name: string; dataType: string; value: string | number | null }[];
  cursors: RoutineCursor[];
  dbmsOutput: string[];
  dbmsOutputTruncated?: boolean;
  error: { message: string; code: string; helpUrl?: string } | null;
}

/** Present on /query responses when the statement touched a versioned code object. */
export interface VersionedInfo {
  action: "CREATE" | "REPLACE" | "DROP" | "UNCHANGED";
  type: string;
  name: string;
  version: number | null;
}

/**
 * Server-authored description of a pending change, returned instead of running it.
 * The backend classifies every operation and refuses to touch the database until the
 * request comes back with `confirm: true` — the dialog wording comes from there too,
 * so the UI never has to decide on its own what counts as dangerous.
 */
export interface GuardConfirmation {
  level: "read" | "write" | "destructive";
  verb: string;
  target: string;
  title: string;
  body: string;
  confirmLabel: string;
  danger: boolean;
}

export interface LiveQueryResult {
  columns: string[];
  rows: (string | number | null)[][];
  durationMs: number;
  rowsReturned: number;
  truncated?: boolean;
  /** `helpUrl`: Oracle 23ai+ ships a docs link with most errors; the server splits it off the message */
  error: { message: string; line: number; code: string; helpUrl?: string } | null;
  versioned?: VersionedInfo | null;
  /** present with error.code === "CONFIRM-REQUIRED": nothing ran, ask and retry with confirm */
  confirmation?: GuardConfirmation;
}

export interface GitHubSyncRequest { repositoryUrl: string; branch: string; directory: string; object: string; type: string; source: string; }
export interface GitHubSyncResult { ok: boolean; path: string; commit: string | null; url: string | null; }

export type AccessRole = "Administrator" | "Developer" | "Analyst" | "Viewer";

/** Who the server actually authenticated this browser as — the real role it will enforce,
 *  not a client-chosen guess. `accountsConfigured` is false only in the zero-setup state
 *  (no workspace accounts created yet), where every request is treated as Administrator. */
export interface SessionInfo { role: AccessRole; email: string | null; name: string | null; accountsConfigured: boolean; }

export interface WorkspaceUser {
  id: string; name: string; email: string; role: AccessRole;
  status: "Active" | "Suspended"; mfa: boolean; createdAt: string;
}
export interface WorkspaceUserInput { name: string; email: string; role: AccessRole; mfa: boolean; password?: string; }

export interface PlanNode {
  op: string;
  object?: string;
  cost: number;
  rows: number;
  bytes: string;
  note?: string;
  children?: PlanNode[];
}

export interface ExplainResult {
  engine: "oracle";
  plan: PlanNode | null;
  totalCost: number;
  note?: string;
  error?: { message: string; code: string; line: number; helpUrl?: string } | null;
}

export interface ImportRequest {
  table: string;
  createNew: boolean;
  columns: string[];
  types?: string[];
  rows: (string | number | null)[][];
}

export interface ImportResult {
  ok: boolean;
  created: boolean;
  inserted: number;
  table: string;
  error?: string;
}

export interface VersionSummary {
  name: string;
  type: string;
  versionCount: number;
  latestVersion: number;
  latestAt: string;
  latestAction: "CREATE" | "REPLACE";
}

export interface CodeVersion {
  version: number;
  at: string;
  action: "CREATE" | "REPLACE";
  hash: string;
  source: string;
}

export interface VersionFile {
  engine: string;
  connKey: string;
  name: string;
  type: string;
  versions: CodeVersion[];
}

export interface CompileResult {
  name: string;
  type: string;
  status: string; // VALID | INVALID | UNKNOWN
  errors: { line: number; position: number; text: string; attribute: string }[];
}

/* ---- Compile invalid objects (Oracle): schema / one group / one object ---- */

export type CompileScopeRef =
  | { scope: "schema" }
  | { scope: "group"; group: string }
  | { scope: "object"; name: string };

export interface CompileTarget { name: string; type: string; group: string }
export interface CompileSkipped { name: string; type: string; group: string; reason: string }

/** Preflight: what a scope *would* compile, and what it cannot. Changes nothing. */
export interface InvalidReport {
  scope: "schema" | "group" | "object";
  scopeLabel: string;
  targets: CompileTarget[];
  skipped: CompileSkipped[];
  breakdown: { type: string; count: number }[];
  total: number;
  cap: number;
  overCap: boolean;
  /** reported rather than enforced here, so the UI can disable its button with the real reason */
  readOnly: boolean;
  systemSchema: boolean;
  checkedAt: string;
}

export interface CompileObjectResult {
  name: string;
  type: string;
  group: string;
  status: string; // VALID | INVALID | UNKNOWN
  attempts: number;
  errors: { line: number; position: number; text: string; attribute: string }[];
  /** the ORA-… the ALTER raised, when user_errors has nothing to say */
  error?: string;
}

export interface CompileBatchResult {
  scope: "schema" | "group" | "object";
  scopeLabel: string;
  passes: number;
  attempted: number;
  compiled: number;
  stillInvalid: number;
  newlyInvalid: number;
  results: CompileObjectResult[];
  skipped: CompileSkipped[];
  /** tree groups touched — drives a targeted refresh instead of dropping the whole catalog */
  groups: string[];
  timedOut: boolean;
  elapsedMs: number;
  note?: string;
}

/**
 * One kind of object a copy can move, as `server/objectCopy.ts` defines it.
 *
 * One kind per run. The names are the backend's whitelist, and they are all that is repeated
 * here: every label, the note saying what a kind carries, the note saying what replacing one
 * costs and all of the counts arrive on the plan (`ObjectCopyPlan.breakdown` covers every
 * kind, chosen or not), so the two sides cannot drift into disagreeing about what a copy
 * contains. Adding a kind is a change to the server plus this one line.
 */
export type CopyKind = "tables" | "indexes";

/** What a copy does with an object the target already has. */
export type CopyExisting = "skip" | "replace";

export interface ObjectCopyKindSummary {
  kind: CopyKind;
  label: string;
  /** what this kind carries with it, and what it leaves behind */
  note: string;
  /** what "drop and recreate" costs for this kind, in the backend's words */
  replaceNote: string;
  selected: boolean;
  total: number;
  /** how many of them the target already has */
  conflicts: number;
}

export interface ObjectCopyItem {
  name: string;
  existsInTarget: boolean;
  /** the table this object needs and the target has not got — it would be skipped, not created */
  missingTable?: string;
}

export interface ObjectCopyPlan {
  sourceId: string;
  sourceName: string;
  sourceSchema: string;
  targetId: string;
  targetName: string;
  targetSchema: string;
  /** the kind this plan was costed for — `breakdown` covers all of them regardless */
  kind: CopyKind;
  label: string;
  breakdown: ObjectCopyKindSummary[];
  items: ObjectCopyItem[];
  total: number;
  conflicts: number;
  /** how many of them name a table the target has not got */
  blocked: number;
  cap: number;
  overCap: boolean;
  targetReadOnly: boolean;
  targetSystemSchema: boolean;
  /** both connections resolve to the same schema on the same database */
  sameSchema: boolean;
  checkedAt: string;
}

export interface ObjectCopyObjectResult {
  name: string;
  status: "created" | "replaced" | "skipped" | "failed";
  reason?: string;
  error?: string;
  statements: number;
}

/** One foreign key of a copied table, added once every table in the run existed. */
export interface ObjectCopyFkResult {
  table: string;
  name: string;
  status: "created" | "skipped" | "failed";
  reason?: string;
  error?: string;
}

export interface ObjectCopyResult {
  sourceName: string;
  sourceSchema: string;
  targetName: string;
  targetSchema: string;
  kind: CopyKind;
  label: string;
  existing: CopyExisting;
  objects: ObjectCopyObjectResult[];
  foreignKeys: ObjectCopyFkResult[];
  created: number;
  replaced: number;
  skipped: number;
  failed: number;
  fksCreated: number;
  fksFailed: number;
  timedOut: boolean;
  elapsedMs: number;
  note?: string;
}

export interface ObjectSource {
  name: string;
  type: string | null;
  source: string | null;
  /** Oracle-maintained schema (SYS, SYSTEM, XDB…): shown read-only, never editable in place. */
  systemObject?: boolean;
  /** PACKAGE/TYPE only: the BODY as its own runnable CREATE OR REPLACE (null when no body exists) */
  bodySource?: string | null;
  error?: string;
}

export interface TableColumnMeta {
  name: string;
  dataType: string;
  baseType: string;
  length: number | null;
  precision: number | null;
  scale: number | null;
  nullable: boolean;
  dataDefault: string | null;
  comment: string | null;
  pk: boolean;
  position: number;
}

export interface TableIndexMeta {
  name: string;
  columns: string[];
  unique: boolean;
  type: string;
  status: string;
  tablespace: string | null;
  constraintBacked: boolean;
}

export interface TableConstraintMeta {
  name: string;
  type: "P" | "U" | "R" | "C";
  typeLabel: string;
  columns: string[];
  status: string;
  validated: string;
  refTable: string | null;
  refColumns: string[];
  searchCondition: string | null;
}

export interface TableMeta {
  name: string;
  engine: "oracle";
  exists: boolean;
  columns: TableColumnMeta[];
  primaryKey: { name: string; columns: string[] } | null;
  tableComment: string | null;
  indexes: TableIndexMeta[];
  constraints: TableConstraintMeta[];
  error?: string;
}

/* ---- Data Browser edit mode: rows identified by ROWID ---- */

export interface RowEditColumn {
  name: string;
  /** display type, e.g. VARCHAR2(50) */
  dataType: string;
  baseType: string;
  nullable: boolean;
  pk: boolean;
  /** false = shown but not writable from the grid; `reason` says why */
  editable: boolean;
  reason?: string;
  maxLength?: number;
}

export interface TableRowsResult {
  table: string;
  columns: RowEditColumn[];
  rows: (string | number | null)[][];
  /** parallel to `rows` — the ROWID each one is written back through */
  rowIds: string[];
  truncated: boolean;
  /** false when nothing here can be written (a view, or every column unsupported) */
  writable: boolean;
  reason?: string;
}

export type RowAction = "insert" | "update" | "delete";

export interface RowChangeRequest {
  table: string;
  action: RowAction;
  /** update/delete only */
  rowId?: string;
  /** insert/update only — just the columns being written */
  values?: Record<string, string | number | null>;
  /** update/delete only — the row as the grid read it, so a reused ROWID matches nothing */
  original?: Record<string, string | number | null>;
}

export interface RowChangeResult {
  ok: boolean;
  action: RowAction;
  table: string;
  /** the statement that ran, binds left as placeholders */
  sql: string;
  rowId: string | null;
  /** the row as it stands after the write, re-read so defaults and triggers show */
  row: (string | number | null)[] | null;
}

export interface ApplyStmtResult {
  sql: string;
  ok: boolean;
  error?: string;
  line?: number;
}

export interface ApplyTableResult {
  results: ApplyStmtResult[];
  failed: boolean;
  applied: number;
}

export interface TableStats {
  table: { numRows: number | null; blocks: number | null; avgRowLen: number | null; lastAnalyzed: string | null; stale: boolean; locked: boolean } | null;
  columns: { name: string; numDistinct: number | null; numNulls: number | null; histogram: string; lastAnalyzed: string | null }[];
  indexes: { name: string; numRows: number | null; distinctKeys: number | null; leafBlocks: number | null; clusteringFactor: number | null; lastAnalyzed: string | null; stale: boolean }[];
}

export type StatsAction = "gather" | "delete" | "lock" | "unlock";

export interface TableStorage {
  table: {
    tablespace: string | null;
    sizeBytes: number | null;
    blocks: number | null;
    extents: number | null;
    pctFree: number | null;
    iniTrans: number | null;
    logging: boolean | null;
    compression: string | null;
    compressFor: string | null;
    partitioned: boolean;
    numRows: number | null;
    avgRowLen: number | null;
  } | null;
  indexes: { name: string; tablespace: string | null; sizeBytes: number | null; status: string; compression: string | null }[];
  tablespaces: { name: string; blockSize: number | null; status: string; contents: string | null }[];
}

export type StorageAction = "move" | "shrink" | "logging" | "rebuildIndexes" | "rebuildIndex";
export type StorageCompression = "KEEP" | "NONE" | "BASIC" | "ADVANCED";
export interface StorageParams {
  tablespace?: string;
  compression?: StorageCompression;
  on?: boolean;
  index?: string;
}
export interface StorageActionResult {
  ok: boolean;
  action: StorageAction;
  statements: string[];
  note?: string;
}

export type AdvisorSeverity = "high" | "medium" | "low" | "info";
export type AdvisorCategory = "primaryKey" | "indexes" | "statistics" | "compression" | "partitioning" | "chainedRows" | "systemObject";
export interface AdvisorFix {
  kind: "ddl" | "stats" | "storage";
  statements?: string[];
  action?: "gather" | "move";
  compression?: StorageCompression;
  label: string;
}
export interface AdvisorFinding {
  id: string;
  category: AdvisorCategory;
  severity: AdvisorSeverity;
  title: string;
  detail: string;
  benefit: string;
  fix?: AdvisorFix;
}
export interface TableAdvisor {
  table: string;
  exists: boolean;
  findings: AdvisorFinding[];
  summary: { high: number; medium: number; low: number; info: number };
  analyzedAt: string;
}

export type MaintenanceAction = "gatherStats" | "rebuildIndexes" | "reorg" | "shrink" | "analyze" | "validateConstraints";
export interface MaintenanceResult {
  ok: boolean;
  action: MaintenanceAction;
  statements: string[];
  note?: string;
}

export interface ChangeLogEntry {
  at: string;
  connId: string;
  connName: string;
  connKey: string;
  engine: string;
  name: string;
  type: string;
  action: "CREATE" | "REPLACE" | "DROP";
  version: number | null;
}

export interface JobRunOutput {
  output: string | null;
  binaryErrors: string | null;
  binaryOutput: string | null;
}

/** Thrown when the backend refused a change because it was not acknowledged (HTTP 409). */
export class ConfirmRequiredError extends Error {
  constructor(message: string, readonly confirmation: GuardConfirmation) {
    super(message);
    this.name = "ConfirmRequiredError";
  }
}

async function request<T>(url: string, body?: unknown, method?: string): Promise<T> {
  const res = await fetch(url, body === undefined && !method
    ? undefined
    : {
        method: method ?? "POST",
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data as { error?: string; code?: string; confirmation?: GuardConfirmation };
    // the write guard: surface the server's description so the caller can ask and retry
    if (res.status === 409 && d.code === "CONFIRM_REQUIRED" && d.confirmation) {
      throw new ConfirmRequiredError(d.error ?? d.confirmation.title, d.confirmation);
    }
    throw new Error(d.error ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

const compileScopeQuery = (ref: CompileScopeRef) =>
  ref.scope === "group"
    ? `scope=group&group=${encodeURIComponent(ref.group)}`
    : ref.scope === "object"
      ? `scope=object&name=${encodeURIComponent(ref.name)}`
      : "scope=schema";

export const api = {
  /** Writes compiled PL/SQL to GitHub through the local backend; the GitHub token stays server-side. */
  githubSync: (req: GitHubSyncRequest) => request<GitHubSyncResult>("/api/github/sync", req),
  /** The role the server will actually enforce for this browser — see SessionInfo. */
  session: () => request<SessionInfo>("/api/session"),
  /** Change your own password. Any signed-in account may call it; Basic auth means the
   *  browser keeps sending the old credential afterwards, so the caller must sign in again. */
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; reauthenticate: boolean }>("/api/session/password", { currentPassword, newPassword }),
  users: () => request<{ users: WorkspaceUser[] }>("/api/users"),
  createUser: (input: WorkspaceUserInput) => request<{ user: WorkspaceUser }>("/api/users", input),
  updateUser: (id: string, input: WorkspaceUserInput & { status: "Active" | "Suspended" }) =>
    request<{ user: WorkspaceUser }>(`/api/users/${id}`, input, "PUT"),
  setUserStatus: (id: string, status: "Active" | "Suspended") =>
    request<{ user: WorkspaceUser }>(`/api/users/${id}/status`, { status }),
  removeUser: (id: string) => request<{ ok: boolean }>(`/api/users/${id}`, undefined, "DELETE"),
  /** Saved connections from the backend registry (metadata only) — lets a browser that has
   *  never seen them rehydrate its list instead of showing "No connections yet". */
  list: () => request<{ connections: StoredConnection[] }>("/api/connections"),
  test: (cfg: LiveConnConfig) => request<TestResult>("/api/connections/test", cfg),
  /** test an existing connection — empty password means "use the stored one" */
  testExisting: (id: string, cfg: LiveConnConfig) => request<TestResult>(`/api/connections/${id}/test`, cfg),
  create: (cfg: LiveConnConfig) => request<{ id: string }>("/api/connections", cfg),
  /** Unpack an Oracle Cloud wallet zip on the backend and list the services inside it. The
   *  wallet files stay server-side; the browser only ever holds the id and the alias list. */
  uploadWallet: (data: string) => request<WalletInfo>("/api/wallets", { data }),
  /** The services of an already-uploaded wallet — how editing a wallet connection repopulates. */
  wallet: (id: string) => request<WalletInfo>(`/api/wallets/${id}`),
  update: (id: string, cfg: LiveConnConfig) => request<{ ok: boolean }>(`/api/connections/${id}`, cfg, "PUT"),
  // through request(), not a bare fetch: fetch resolves on 4xx/5xx, so a failed DELETE
  // used to look like a success and the connection vanished from the UI while the
  // backend still held it — and its password
  remove: (id: string) => request<{ ok: boolean }>(`/api/connections/${id}`, undefined, "DELETE"),
  /** Passphrase-encrypted export of saved connections (passwords included, encrypted
   *  server-side). `ids` omitted means every saved connection. */
  exportConnections: (password: string, ids?: string[]) =>
    request<{ file: ConnectionExportFile; count: number }>("/api/connections/export", { password, ids }),
  /** Decrypt an uploaded export and describe it — metadata only, nothing is written. */
  previewConnectionImport: (file: unknown, password: string) =>
    request<ImportPreview>("/api/connections/import/preview", { file, password }),
  /** Apply an import. `indexes` picks entries from the file; `mode` decides what happens to
   *  an entry that points where a saved connection already points. */
  importConnections: (file: unknown, password: string, indexes: number[], mode: "skip" | "replace") =>
    request<ConnectionImportResult>("/api/connections/import", { file, password, indexes, mode }),
  /** close the pooled sessions but keep the saved connection */
  disconnect: (id: string) => request<DisconnectResult>(`/api/connections/${id}/disconnect`, {}),
  /** close the pooled sessions and open a fresh one */
  reconnect: (id: string) => request<TestResult>(`/api/connections/${id}/reconnect`, {}),
  schema: (id: string) => request<LiveSchema>(`/api/connections/${id}/schema`),
  /** re-read a single group of the tree (Procedures, Packages, …) instead of the whole catalog */
  schemaGroup: (id: string, label: string) =>
    request<SchemaGroupResult>(`/api/connections/${id}/schema/group?label=${encodeURIComponent(label)}`),
  dba: (id: string) => request<DbaReport>(`/api/connections/${id}/dba`),
  perf: (id: string) => request<PerfReport>(`/api/connections/${id}/perf`),
  deps: (id: string, name: string) => request<DepsReport>(`/api/connections/${id}/deps?name=${encodeURIComponent(name)}`),
  erd: (id: string) => request<ErdResult>(`/api/connections/${id}/erd`),
  /** `type` disambiguates objects whose names differ only in case (lowercase synonym vs uppercase view). */
  source: (id: string, name: string, type?: string) =>
    request<ObjectSource>(
      `/api/connections/${id}/source?name=${encodeURIComponent(name)}${type ? `&type=${encodeURIComponent(type)}` : ""}`
    ),
  compile: (id: string, name: string, type: string, confirm = false) =>
    request<CompileResult>(`/api/connections/${id}/compile`, { name, type, confirm }),
  /** Preflight for "compile invalid objects" — a read, safe to call on any Oracle connection. */
  compileTargets: (id: string, ref: CompileScopeRef) =>
    request<InvalidReport>(`/api/connections/${id}/compile/invalid?${compileScopeQuery(ref)}`),
  compileInvalid: (id: string, ref: CompileScopeRef, confirm = false) =>
    request<CompileBatchResult>(`/api/connections/${id}/compile/invalid`, { ...ref, confirm }),
  /**
   * What copying `sourceId`'s objects of one kind into `targetId` would do — a read of both
   * dictionaries that changes neither. Addressed by the **target**, which is the connection
   * about to be written to and therefore the one the server's guards are about.
   */
  objectCopyPlan: (targetId: string, sourceId: string, kind: CopyKind) =>
    request<ObjectCopyPlan>(
      `/api/connections/${targetId}/objects/copy?source=${encodeURIComponent(sourceId)}&kind=${encodeURIComponent(kind)}`
    ),
  /** Run it — unacknowledged calls come back as ConfirmRequiredError with the dialog wording. */
  objectCopy: (
    targetId: string,
    req: {
      sourceId: string;
      kind: CopyKind;
      existing: CopyExisting;
      /** the objects to copy; omitted (not empty) means every object of the kind */
      names?: string[];
      preserveTablespace: boolean;
    },
    confirm = false
  ) => request<ObjectCopyResult>(`/api/connections/${targetId}/objects/copy`, { ...req, confirm }),
  versions: (id: string) => request<{ connKey: string; objects: VersionSummary[] }>(`/api/connections/${id}/versions`),
  versionsOf: (id: string, name: string, type: string) =>
    request<VersionFile>(`/api/connections/${id}/versions/object?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`),
  changelog: (id: string) => request<{ connKey: string; entries: ChangeLogEntry[] }>(`/api/connections/${id}/changelog`),
  /** Captured DBMS_SCHEDULER output, including the BLOB-backed error/output streams. */
  jobRunOutput: (id: string, logId: number) => request<JobRunOutput>(`/api/connections/${id}/job-runs/${logId}/output`),
  /**
   * Mutating calls carry `confirm` — false (the default) makes the backend describe the
   * change instead of running it. Only pass true right after a user confirmed *this* action.
   */
  query: (id: string, sql: string, confirm = false) => request<LiveQueryResult>(`/api/connections/${id}/query`, { sql, confirm }),
  explain: (id: string, sql: string) => request<ExplainResult>(`/api/connections/${id}/explain`, { sql }),
  importData: (id: string, req: ImportRequest, confirm = false) =>
    request<ImportResult>(`/api/connections/${id}/import`, { ...req, confirm }),
  tableMeta: (id: string, name: string) => request<TableMeta>(`/api/connections/${id}/table?name=${encodeURIComponent(name)}`),
  applyTableDdl: (id: string, statements: string[], confirm = false) =>
    request<ApplyTableResult>(`/api/connections/${id}/table/apply`, { statements, confirm }),
  /** Rows of a table plus their ROWIDs — the Data Browser edit-mode read (any browsing role). */
  tableRows: (id: string, name: string) => request<TableRowsResult>(`/api/connections/${id}/table/rows?name=${encodeURIComponent(name)}`),
  /** Insert / update / delete one row. Unacknowledged calls come back as ConfirmRequiredError. */
  changeTableRow: (id: string, req: RowChangeRequest, confirm = false) =>
    request<RowChangeResult>(`/api/connections/${id}/table/rows`, { ...req, confirm }),
  tableStats: (id: string, name: string) => request<TableStats>(`/api/connections/${id}/table/stats?name=${encodeURIComponent(name)}`),
  tableStatsAction: (id: string, name: string, action: StatsAction, confirm = false) =>
    request<{ ok: boolean; action: StatsAction }>(`/api/connections/${id}/table/stats`, { name, action, confirm }),
  tableStorage: (id: string, name: string) => request<TableStorage>(`/api/connections/${id}/table/storage?name=${encodeURIComponent(name)}`),
  tableStorageAction: (id: string, name: string, action: StorageAction, params: StorageParams = {}, confirm = false) =>
    request<StorageActionResult>(`/api/connections/${id}/table/storage`, { name, action, ...params, confirm }),
  tableAdvisor: (id: string, name: string) => request<TableAdvisor>(`/api/connections/${id}/table/advisor?name=${encodeURIComponent(name)}`),
  tableMaintenance: (id: string, name: string, action: MaintenanceAction, confirm = false) =>
    request<MaintenanceResult>(`/api/connections/${id}/table/maintenance`, { name, action, confirm }),
  /** signature of a runnable routine (Oracle) — packages list their members */
  routine: (id: string, name: string) => request<RoutineMeta>(`/api/connections/${id}/routine?name=${encodeURIComponent(name)}`),
  /** run it — unacknowledged calls come back as ConfirmRequiredError with the dialog wording */
  routineRun: (id: string, req: RoutineRunRequest, confirm = false) =>
    request<RoutineRunResult>(`/api/connections/${id}/routine/run`, { ...req, confirm }),
};
