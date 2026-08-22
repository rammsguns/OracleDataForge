/** Thin client for the local Oracle DataForge backend. */

export interface LiveConnConfig {
  name: string;
  engine: "oracle";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  readOnly?: boolean;
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
  update: (id: string, cfg: LiveConnConfig) => request<{ ok: boolean }>(`/api/connections/${id}`, cfg, "PUT"),
  // through request(), not a bare fetch: fetch resolves on 4xx/5xx, so a failed DELETE
  // used to look like a success and the connection vanished from the UI while the
  // backend still held it — and its password
  remove: (id: string) => request<{ ok: boolean }>(`/api/connections/${id}`, undefined, "DELETE"),
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
