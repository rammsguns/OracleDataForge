import oracledb from "oracledb";
import { identitySequenceOptions } from "./tableDataCopy.ts";
import { compareCatalog, compareRows, compareSchemaObjects, compareDataLiteral } from "./schemaCompare.ts";
import { compareObjectKey as key, quoteCompareIdentifier as qi, type CompareCatalog, type CompareObject, type SchemaDifference } from "../src/utils/schemaCompare.ts";
import type { PackageInstallPlan, PackageInstallRequest } from "../src/utils/packageInstall.ts";

type Row = Record<string, unknown>;
const cleanComment = (s: string) => s.replace(/[\r\n\u2028\u2029]/g, " ");
const obj = (name: unknown, type: unknown): CompareObject => ({ name: String(name), type: String(type) });

/** Keep identifier positions, but remove comments and string contents from static evidence. */
export function staticPlsql(text: string): string {
  let result = "", i = 0;
  while (i < text.length) {
    const start = i;
    if (text.startsWith("--", i)) { const end = text.indexOf("\n", i); i = end < 0 ? text.length : end; }
    else if (text.startsWith("/*", i)) { const end = text.indexOf("*/", i + 2); i = end < 0 ? text.length : end + 2; }
    else if (/^[qQ]'/.test(text.slice(i, i + 2))) {
      const delimiter = text[i + 2], close = ({ "[": "]", "(": ")", "{": "}", "<": ">" } as Record<string, string>)[delimiter] ?? delimiter;
      const end = text.indexOf(`${close}'`, i + 3); i = end < 0 ? text.length : end + 2;
    } else if (text[i] === "'") {
      i++;
      while (i < text.length) { if (text[i++] === "'") { if (text[i] === "'") i++; else break; } }
    } else if (text[i] === '"') {
      i++;
      while (i < text.length) { if (text[i++] === '"') { if (text[i] === '"') i++; else break; } }
      result += text.slice(start, i); continue;
    } else { result += text[i++]; continue; }
    result += text.slice(start, i).replace(/[^\r\n]/g, " ");
  }
  return result;
}

export function tableUsage(table: string, sources: { name: string; text: string }[], schema?: string) {
  const reasons: string[] = [], evidence: string[] = [];
  let read = false, write = false;
  // Match Oracle identifiers as complete tokens, including quoted case-sensitive names.
  const identifier = `(?:"(?:[^"]|"")+"|[A-Za-z][A-Za-z0-9_$#]*)`;
  const pattern = new RegExp(`\\b(FROM|JOIN|UPDATE|INSERT\\s+INTO|MERGE\\s+INTO|DELETE(?:\\s+FROM)?)\\s+(${identifier})(?:\\s*\\.\\s*(${identifier}))?`, "gi");
  const unquote = (s: string) => s.startsWith('"') ? s.slice(1, -1).replace(/""/g, '"') : s.toUpperCase();
  for (const source of sources) {
    const text = staticPlsql(source.text);
    for (const m of text.matchAll(pattern)) {
      if (unquote(m[3] ?? m[2]) !== table) continue;
      if (m[3] && schema && unquote(m[2]) !== schema) continue;
      const isRead = /^(FROM|JOIN)$/i.test(m[1]);
      read ||= isRead; write ||= !isRead;
      const line = text.slice(0, m.index).split("\n").length;
      if (evidence.length < 12) evidence.push(`${source.name}:${line} ${m[0].trim()}`);
    }
  }
  if (read && !write) reasons.push("Read by PL/SQL with no static writes found: possible reference data.");
  if (write) reasons.push("PL/SQL writes to this table: review as possible transactional data.");
  const catalogName = /(?:^|_)(?:CAT(?:ALOG)?|STATUS(?:ES)?|ESTADO(?:S)?|LOOKUP|CONFIG|PARAM(?:ETER)?S?|BLACK_?LIST|BLOCK_?LIST)(?:_|$)/i.test(table);
  if (catalogName) reasons.push("Name suggests a catalog, status, configuration or blacklist table.");
  if (!reasons.length) reasons.push("Required table; no direct static SQL usage classified (it may be used through a view).");
  return { table, recommended: !write && (read || catalogName), reasons, evidence };
}

/** Dependencies before dependents; cycles are surfaced rather than silently treated as ordered. */
export function dependencyOrder(objects: CompareObject[], edges: Map<string, CompareObject[]>) {
  const available = new Map(objects.map(o => [key(o), o]));
  const active = new Set<string>(), done = new Set<string>(), ordered: CompareObject[] = [], cycles: string[] = [];
  const visit = (o: CompareObject) => {
    const k = key(o);
    if (done.has(k)) return;
    if (active.has(k)) { cycles.push(`${o.type} ${o.name}`); return; }
    active.add(k);
    for (const d of edges.get(k) ?? []) if (available.has(key(d))) visit(available.get(key(d))!);
    active.delete(k); done.add(k); ordered.push(o);
  };
  objects.forEach(visit);
  return { ordered, cycles };
}

/** The standard comparison must expand package selections too, not just the install wizard. */
export async function expandPackageSelection(conn: oracledb.Connection, catalog: CompareCatalog, selected: CompareObject[]) {
  const roots = [...new Set(selected.filter(o => /^(PACKAGE|PACKAGE BODY)$/.test(o.type) && catalog.objects.some(c => key(c) === key(o))).map(o => o.name))];
  if (!roots.length) return { objects: selected, warnings: [] as string[], edges: new Map<string, CompareObject[]>() };
  const closure = await packageClosure(conn, catalog, roots);
  const union = [...new Map([...selected, ...closure.objects].map(o => [key(o), o])).values()];
  if (union.length > 500) throw new Error("Selection with package dependencies exceeds 500 objects. Select fewer roots; dependencies were not omitted.");
  return { objects: dependencyOrder(union, closure.edges).ordered, warnings: closure.warnings, edges: closure.edges };
}

async function boundedRows(conn: oracledb.Connection, sql: string, binds: Record<string, string>) {
  const rows = await compareRows(conn, sql, binds);
  if (rows.length > 20000) throw new Error("Dependency metadata exceeds 20,000 rows. Narrow the source schema; no incomplete plan was generated.");
  return rows;
}

export async function packageClosure(conn: oracledb.Connection, catalog: CompareCatalog, roots: string[]) {
  const owner = catalog.schema;
  const objects = new Map(catalog.objects.map(o => [key(o), o]));
  const edges = new Map<string, CompareObject[]>(), warnings = new Set<string>();
  const external = new Map<string, Row[]>(), reached = new Map<string, CompareObject>();
  const add = (a: CompareObject, b: CompareObject) => {
    const list = edges.get(key(a)) ?? [];
    if (!list.some(o => key(o) === key(b))) list.push(b);
    edges.set(key(a), list);
  };
  const outside = (a: CompareObject, r: Row) => {
    const list = external.get(key(a)) ?? []; list.push(r); external.set(key(a), list);
  };
  let metadataRows = 0;
  const read = async (stage: string, sql: string, binds: Record<string, string>) => {
    try {
      const rows = await boundedRows(conn, sql, binds);
      metadataRows += rows.length;
      if (metadataRows > 20000) throw new Error('Dependency metadata exceeds 20,000 rows; select fewer packages.');
      return rows;
    } catch (e) { throw new Error(stage + ': ' + (e instanceof Error ? e.message : String(e))); }
  };
  const queue = roots.map(name => obj(name, 'PACKAGE'));
  for (const root of queue) if (!objects.has(key(root))) throw new Error('Package ' + root.name + ' is not visible in the source schema.');
  while (queue.length) {
    const batch: CompareObject[] = [];
    while (queue.length && batch.length < 50) {
      const o = queue.shift()!, k = key(o);
      if (reached.has(k)) continue;
      if (!objects.has(k)) { warnings.add('Unresolved source dependency: ' + o.type + ' ' + o.name + '. Check visibility, grants and synonyms.'); continue; }
      reached.set(k, o); batch.push(o);
      if (reached.size > 500) throw new Error('Package dependency closure exceeds 500 objects. Select fewer packages; no dependencies were silently omitted.');
      if (o.type === 'PACKAGE' || o.type === 'TYPE') {
        const body = obj(o.name, o.type + ' BODY');
        if (objects.has(key(body))) { add(body, o); queue.push(body); }
      }
    }
    if (!batch.length) continue;
    const names = [...new Set(batch.map(o => o.name))];
    const binds = { owner, ...Object.fromEntries(names.map((n, i) => ['n' + i, n])) };
    const placeholders = names.map((_, i) => ':n' + i).join(',');
    const deps = await read('Reading dependencies for ' + names.join(', '),
      'SELECT name, type, referenced_owner, referenced_name, referenced_type, referenced_link_name FROM all_dependencies WHERE owner = :owner AND name IN (' + placeholders + ')', binds);
    for (const r of deps) {
      const a = obj(r.NAME, r.TYPE);
      if (!batch.some(o => key(o) === key(a))) continue;
      if (r.REFERENCED_OWNER === owner && !r.REFERENCED_LINK_NAME) add(a, obj(r.REFERENCED_NAME, r.REFERENCED_TYPE));
      else outside(a, r);
    }
    const tables = batch.filter(o => o.type === 'TABLE').map(o => o.name);
    if (tables.length) {
      const tableBinds = { owner, ...Object.fromEntries(tables.map((n, i) => ['t' + i, n])) };
      const list = tables.map((_, i) => ':t' + i).join(',');
      const fks = await read('Reading foreign-key parents', `SELECT c.table_name, p.owner parent_owner, p.table_name parent_table
        FROM all_constraints c JOIN all_constraints p ON p.owner = c.r_owner AND p.constraint_name = c.r_constraint_name
        WHERE c.owner = :owner AND c.constraint_type = 'R' AND c.table_name IN (` + list + ')', tableBinds);
      for (const r of fks) {
        const a = obj(r.TABLE_NAME, 'TABLE');
        if (r.PARENT_OWNER === owner) add(a, obj(r.PARENT_TABLE, 'TABLE'));
        else outside(a, { REFERENCED_OWNER: r.PARENT_OWNER, REFERENCED_TYPE: 'TABLE', REFERENCED_NAME: r.PARENT_TABLE });
      }
      const related = await read('Reading indexes and triggers', `SELECT index_name object_name, 'INDEX' object_type, table_name FROM all_indexes i
        WHERE owner = :owner AND table_owner = :owner AND table_name IN (` + list + `) AND generated = 'N' AND index_type <> 'LOB'
        AND NOT EXISTS (SELECT 1 FROM all_constraints c WHERE c.owner = :owner AND c.table_name = i.table_name AND c.constraint_type IN ('P', 'U') AND c.index_owner = i.owner AND c.index_name = i.index_name)
        UNION ALL SELECT trigger_name object_name, 'TRIGGER' object_type, table_name FROM all_triggers WHERE owner = :owner AND table_owner = :owner AND table_name IN (` + list + ')', tableBinds);
      for (const r of related) { const child = obj(r.OBJECT_NAME, r.OBJECT_TYPE); add(child, obj(r.TABLE_NAME, 'TABLE')); queue.push(child); }
    }
    const syns = batch.filter(o => o.type === 'SYNONYM').map(o => o.name);
    if (syns.length) {
      const synBinds = { owner, ...Object.fromEntries(syns.map((n, i) => ['s' + i, n])) };
      const rows = await read('Resolving local synonyms', 'SELECT synonym_name, table_owner, table_name, db_link FROM all_synonyms WHERE owner = :owner AND synonym_name IN (' + syns.map((_, i) => ':s' + i).join(',') + ')', synBinds);
      for (const r of rows) {
        const a = obj(r.SYNONYM_NAME, 'SYNONYM');
        if (r.TABLE_OWNER === owner && !r.DB_LINK) {
          for (const b of catalog.objects.filter(o => o.name === r.TABLE_NAME && !o.type.endsWith(' BODY'))) add(a, b);
        } else outside(a, { REFERENCED_OWNER: r.TABLE_OWNER, REFERENCED_NAME: r.TABLE_NAME, REFERENCED_TYPE: 'SYNONYM TARGET', REFERENCED_LINK_NAME: r.DB_LINK });
      }
    }
    for (const o of batch) {
      queue.push(...(edges.get(key(o)) ?? []));
      for (const r of external.get(key(o)) ?? []) warnings.add(`External prerequisite for ${o.type} ${o.name}: ${r.REFERENCED_OWNER}.${r.REFERENCED_NAME} (${r.REFERENCED_TYPE})${r.REFERENCED_LINK_NAME ? ' via ' + r.REFERENCED_LINK_NAME : ''}. Verify on target with required direct grants; not copied or remapped.`);
    }
  }
  const { ordered, cycles } = dependencyOrder([...reached.values()], edges);
  if (!ordered.some(o => /^(TABLE|VIEW|MATERIALIZED VIEW|SEQUENCE)$/.test(o.type))) warnings.add('No local table, view or sequence dependencies were found. Check package body visibility, invalid source compilation, dynamic SQL and external-schema prerequisites.');
  if (cycles.length) warnings.add('Dependency cycles require manual ordering or staged compilation: ' + cycles.join(', ') + '.');
  const prerequisites = [...new Map([...reached.keys()].flatMap(k => external.get(k) ?? []).map(r => [JSON.stringify([r.REFERENCED_OWNER, r.REFERENCED_NAME, r.REFERENCED_TYPE, r.REFERENCED_LINK_NAME]), r])).values()];
  return { objects: ordered, edges, warnings: [...warnings], prerequisites };
}
const scalarTypes = /^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|NUMBER|FLOAT|DATE|TIMESTAMP(?:\(\d+\))?(?: WITH TIME ZONE)?|RAW|ROWID|UROWID)$/;
const lobTypes = new Set(['CLOB', 'NCLOB', 'BLOB']);
const SEED_SCRIPT_BYTES = 20 * 1024 * 1024;
export class SeedExportError extends Error {
  constructor(message: string, public readonly details: import('../src/utils/packageInstall.ts').SeedExportDetails) { super(message); this.name = 'SeedExportError'; }
}

export async function exportSeedTable(source: oracledb.Connection, target: oracledb.Connection, input: PackageInstallRequest, table: string, exists: boolean) {
  const details: import('../src/utils/packageInstall.ts').SeedExportDetails = { stage: 'describe source columns', sourceSchema: input.sourceSchema, targetSchema: input.targetSchema, table, columns: [], advice: 'Review the column diagnostics and retry. No partial table script was generated.' };
  const warnings: string[] = [];
  const preparationSql: string[] = [], finalizeSql: string[] = [], schemaSql: string[] = [];
  try {
    const describe = (conn: oracledb.Connection, owner: string) => compareRows(conn, `SELECT column_name, data_type, data_length, data_precision, data_scale, char_length, char_used, nullable, virtual_column, identity_column
      FROM all_tab_cols WHERE owner = :owner AND table_name = :name AND hidden_column = 'NO' ORDER BY column_id`, { owner, name: table });
    const allCols = await describe(source, input.sourceSchema);
    if (!allCols.length) throw new Error('No visible source columns. Verify table visibility and dictionary privileges.');
    const cols = allCols.filter(c => c.VIRTUAL_COLUMN !== 'YES');
    const virtuals = allCols.filter(c => c.VIRTUAL_COLUMN === 'YES');
    if (virtuals.length) warnings.push('Virtual columns omitted; Oracle recomputes: ' + virtuals.map(c => String(c.COLUMN_NAME)).join(', '));
    if (!cols.length) throw new Error('No writable columns remain after omitting virtual columns.');
    details.columns = cols.filter(c => !scalarTypes.test(String(c.DATA_TYPE)) && !lobTypes.has(String(c.DATA_TYPE))).map(c => ({ name: String(c.COLUMN_NAME), type: String(c.DATA_TYPE), reason: 'Unsupported seed data type' }));
    if (details.columns.length) { details.advice = 'Use Oracle Data Pump or a type-specific export for these columns; they were not silently dropped.'; throw new Error('Unsupported columns: ' + details.columns.map(c => c.name + ' (' + c.type + ')').join(', ')); }
    details.stage = 'check target column compatibility';
    if (exists) {
      const targetCols = await describe(target, input.targetSchema);
      const incompatible: typeof details.columns = [];
      const names = [...new Set([...allCols, ...targetCols].map(c => String(c.COLUMN_NAME)))];
      for (const name of names) {
        const a = allCols.find(c => c.COLUMN_NAME === name), b = targetCols.find(c => c.COLUMN_NAME === name);
        if (JSON.stringify(a) === JSON.stringify(b)) continue;
        if (a && b && ['VARCHAR2', 'NVARCHAR2'].includes(String(a.DATA_TYPE)) && a.DATA_TYPE === b.DATA_TYPE) {
          const {DATA_LENGTH: _al, CHAR_LENGTH: _ac, ...restA} = a;
          const {DATA_LENGTH: _bl, CHAR_LENGTH: _bc, ...restB} = b;
          const length = Number(a.CHAR_USED === 'C' || a.DATA_TYPE === 'NVARCHAR2' ? a.CHAR_LENGTH : a.DATA_LENGTH);
          const targetLength = Number(b.CHAR_USED === 'C' || b.DATA_TYPE === 'NVARCHAR2' ? b.CHAR_LENGTH : b.DATA_LENGTH);
          if (JSON.stringify(restA) === JSON.stringify(restB) && Number.isInteger(length) && length > 0 && length <= 32767 && targetLength > 0) {
            if (length > targetLength) {
              const unit = a.DATA_TYPE === 'NVARCHAR2' ? '' : a.CHAR_USED === 'C' ? ' CHAR' : ' BYTE';
              schemaSql.push('ALTER TABLE ' + qi(input.targetSchema) + '.' + qi(table) + ' MODIFY (' + qi(name) + ' ' + a.DATA_TYPE + '(' + length + unit + '));');
              warnings.push('Target column ' + name + ' is narrower (' + targetLength + ' vs source ' + length + '). The generated script widens it before loading; review the ALTER statement.');
            } else warnings.push('Target column ' + name + ' is wider than the source and is retained.');
            continue;
          }
        }
        incompatible.push({name, type: String(a?.DATA_TYPE ?? b?.DATA_TYPE), reason: !a ? 'Target-only column' : !b ? 'Missing target column' : 'Incompatible source/target type, precision, nullability or generation attributes'});
      }
      if (incompatible.length) {
        details.columns = incompatible;
        details.advice = 'Deploy matching column definitions before exporting INSERTs. Only safe VARCHAR2/NVARCHAR2 widening is generated automatically.';
        throw new Error('Source and target column layouts differ: ' + details.columns.map(c => c.name + ' (' + c.type + ')').join(', '));
      }
    }

    const identities = cols.filter(c => c.IDENTITY_COLUMN === 'YES');
    if (identities.length) {
      details.stage = 'check identity generation modes';
      const modes = await compareRows(exists ? target : source, 'SELECT column_name, generation_type, identity_options FROM all_tab_identity_cols WHERE owner = :owner AND table_name = :name', { owner: exists ? input.targetSchema : input.sourceSchema, name: table });
      details.columns = identities.flatMap(c => {
        const mode = String(modes.find(m => m.COLUMN_NAME === c.COLUMN_NAME)?.GENERATION_TYPE ?? 'UNKNOWN');
        return ['ALWAYS', 'BY DEFAULT', 'BY DEFAULT ON NULL'].includes(mode) ? [] : [{ name: String(c.COLUMN_NAME), type: String(c.DATA_TYPE), reason: 'Unknown identity generation mode ' + mode }];
      });
      if (details.columns.length) { details.advice = 'Use the dedicated table data copy workflow, which manages ALWAYS identity modes and sequence synchronization. IDs cannot be regenerated without risking broken foreign keys.'; throw new Error(details.columns.map(c => c.name + ': ' + c.reason).join('; ')); }
      for (const c of identities) {
        const mode = modes.find(m => m.COLUMN_NAME === c.COLUMN_NAME)!;
        details.columns = [{name: String(c.COLUMN_NAME), type: String(c.DATA_TYPE), reason: 'Validate identity sequence options'}];
        const options = identitySequenceOptions(String(mode.IDENTITY_OPTIONS ?? ''));
        const column = qi(String(c.COLUMN_NAME)), targetTable = qi(input.targetSchema) + '.' + qi(table);
        if (mode.GENERATION_TYPE === 'ALWAYS') {
          preparationSql.push('ALTER TABLE ' + targetTable + ' MODIFY (' + column + ' GENERATED BY DEFAULT AS IDENTITY);');
          finalizeSql.push('ALTER TABLE ' + targetTable + ' MODIFY (' + column + ' GENERATED ALWAYS AS IDENTITY);');
        }
        finalizeSql.push('ALTER TABLE ' + targetTable + ' MODIFY (' + column + ' GENERATED AS IDENTITY (START WITH LIMIT VALUE ' + options + '));');
      }
      warnings.push('Identity IDs preserved for ' + identities.map(c => String(c.COLUMN_NAME)).join(', ') + '. The generated script explicitly commits seed data before synchronizing identity sequences and restoring ALWAYS modes. Run during a maintenance window; use the recovery script if interrupted.');
    }
    details.stage = 'read primary keys';
    const primaryKey = async (conn: oracledb.Connection, owner: string) => (await compareRows(conn, `SELECT cc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
      WHERE c.owner = :owner AND c.table_name = :name AND c.constraint_type = 'P' AND c.status = 'ENABLED' ORDER BY cc.position`, { owner, name: table })).map(r => String(r.COLUMN_NAME));
    const keys = await primaryKey(source, input.sourceSchema);
    if (keys.some(k => !cols.some(c => c.COLUMN_NAME === k))) throw new Error('Primary key includes a generated or unavailable column; seed matching cannot preserve keys.');
    if (exists && (!keys.length || JSON.stringify(keys) !== JSON.stringify(await primaryKey(target, input.targetSchema)))) throw new Error('Existing target tables require matching enabled primary keys for insert-only seeding.');
    const expression = (c: Row) => {
      const name = qi(String(c.COLUMN_NAME)), type = String(c.DATA_TYPE);
      if (/^(NUMBER|FLOAT)$/.test(type)) return `TO_CHAR(${name}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')`;
      if (type === 'DATE') return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS', 'NLS_DATE_LANGUAGE=English')`;
      if (type.startsWith('TIMESTAMP')) return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS.FF9${type.includes('TIME ZONE') ? ' TZH:TZM' : ''}', 'NLS_DATE_LANGUAGE=English')`;
      if (type === 'RAW') return `RAWTOHEX(${name})`;
      return name;
    };
    details.stage = 'fetch source rows';
    const result = await source.execute<Row>(`SELECT ${cols.map(c => `${expression(c)} AS ${qi(String(c.COLUMN_NAME))}`).join(', ')} FROM ${qi(input.sourceSchema)}.${qi(table)}${keys.length ? ' ORDER BY ' + keys.map(qi).join(', ') : ''} FETCH FIRST ${input.rowLimit + 1} ROWS ONLY`, {}, {
      outFormat: oracledb.OUT_FORMAT_OBJECT, resultSet: true, fetchArraySize: 1, prefetchRows: 1,
      fetchTypeHandler: meta => meta.dbType === oracledb.CLOB || meta.dbType === oracledb.NCLOB || meta.dbType === oracledb.BLOB ? { type: meta.dbType } : undefined,
    });
    const cursor = result.resultSet;
    const fallback = [...(result.rows ?? [])]; // Also supports non-cursor driver adapters.
    const targetTable = `${qi(input.targetSchema)}.${qi(table)}`;
    let count = 0, bytes = 0;
    const scripts: string[] = [];
    const append = (s: string) => { bytes += Buffer.byteLength(s); if (bytes > SEED_SCRIPT_BYTES) throw new Error('Table script exceeds the 20 MiB budget. Reduce the export or use Oracle Data Pump.'); scripts.push(s); };
    try {
      while (true) {
        details.stage = 'fetch source rows'; details.columns = [];
        const row = cursor ? await cursor.getRow() : fallback.shift();
        if (!row) break;
        count++; details.row = count;
        const locators = Object.values(row).filter((v): v is oracledb.Lob => !!v && typeof v === 'object' && 'getData' in v && 'close' in v);
        try {
          if (count > input.rowLimit) throw new Error('More than ' + input.rowLimit + ' rows: no partial INSERT export generated. Increase the row limit.');
          const declarations: string[] = [], setup: string[] = [], cleanup: string[] = [], values: string[] = [];
          for (let i = 0; i < cols.length; i++) {
            const c = cols[i], name = String(c.COLUMN_NAME), type = String(c.DATA_TYPE);
            details.stage = 'serialize source value'; details.columns = [{ name, type, reason: 'Value serialization' }];
            let value = row[name];
            if (value != null && lobTypes.has(type)) {
              if (value && typeof value === 'object' && 'getData' in value) {
                const lob = value as oracledb.Lob;
                if (lob.length > SEED_SCRIPT_BYTES) throw new Error('LOB exceeds the 20 MiB seed budget. Use Oracle Data Pump for large objects.');
                value = await lob.getData();
              }
              if (type === 'BLOB' && !Buffer.isBuffer(value)) throw new Error('BLOB fetch did not return binary data.');
              if (type !== 'BLOB' && typeof value !== 'string') throw new Error('Character LOB fetch did not return text.');
              if (Buffer.byteLength(value as string | Buffer) > SEED_SCRIPT_BYTES) throw new Error('LOB exceeds the 20 MiB seed budget.');
              const variable = 'df_lob_' + i;
              declarations.push('  ' + variable + ' ' + type + ';');
              setup.push('  DBMS_LOB.CREATETEMPORARY(' + variable + ', TRUE);');
              if (type === 'BLOB') {
                const buffer = value as Buffer;
                for (let offset = 0; offset < buffer.length; offset += 1000) {
                  const hex = buffer.subarray(offset, offset + 1000).toString('hex');
                  setup.push(`  DBMS_LOB.WRITEAPPEND(${variable}, ${hex.length / 2}, HEXTORAW('${hex}'));`);
                }
              } else {
                const chars = Array.from(value as string);
                for (let offset = 0; offset < chars.length; offset += 500) {
                  const chunk = chars.slice(offset, offset + 500).join('');
                  const literal = compareDataLiteral(chunk, type === 'NCLOB' ? 'NVARCHAR2' : 'VARCHAR2');
                  setup.push(`  DBMS_LOB.APPEND(${variable}, ${type === 'NCLOB' ? 'TO_NCLOB' : 'TO_CLOB'}(${literal}));`);
                }
              }
              values.push(variable);
              cleanup.push(`  IF ${variable} IS NOT NULL AND DBMS_LOB.ISTEMPORARY(${variable}) = 1 THEN DBMS_LOB.FREETEMPORARY(${variable}); END IF;`);
            } else values.push(compareDataLiteral(value == null ? null : String(value), type));
          }
          details.stage = 'generate insert statement';
          const literal = (name: string) => compareDataLiteral(row[name] == null ? null : String(row[name]), String(cols.find(c => c.COLUMN_NAME === name)!.DATA_TYPE));
          const into = `INSERT INTO ${targetTable} (${cols.map(c => qi(String(c.COLUMN_NAME))).join(', ')})`;
          const insert = keys.length ? `${into} SELECT ${values.join(', ')} FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM ${targetTable} WHERE ${keys.map(k => `${qi(k)} = ${literal(k)}`).join(' AND ')});` : `${into} VALUES (${values.join(', ')});`;
          append(declarations.length ? ['DECLARE', ...declarations, 'BEGIN', ...setup, '  ' + insert, ...cleanup, 'EXCEPTION WHEN OTHERS THEN', ...cleanup, '  RAISE;', 'END;', '/'].join('\n') : insert);
        } finally { for (const lob of locators) await lob.close().catch(() => {}); }
      }
    } finally { await cursor?.close(); }
    return { table, rows: count, warnings, schemaSql, preparationSql: count ? preparationSql : [], finalizeSql: count ? finalizeSql : [], script: [!keys.length ? '-- REVIEW: No primary key; INSERTs are not rerunnable.' : '-- Existing primary keys are preserved; differing target values are not overwritten.', ...warnings.map(w => '-- REVIEW: ' + cleanComment(w)), ...scripts].join('\n') };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new SeedExportError(message, { ...details, code: /\b(?:ORA-\d+|NJS-\d+)/.exec(message)?.[0] ?? 'SEED_EXPORT_FAILED' });
  }
}
export function packageMetadataTimeout(): number {
  const value = Number(process.env.DATAFORGE_PACKAGE_CALL_TIMEOUT_MS ?? 180000);
  return Number.isFinite(value) && value >= 1000 && value <= 300000 ? Math.floor(value) : 180000;
}

async function packageStage<T>(name: string, work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (e) { throw new Error(name + ': ' + (e instanceof Error ? e.message : String(e))); }
}

export async function buildPackageInstall(source: oracledb.Connection, target: oracledb.Connection, input: PackageInstallRequest, sourceName: string, targetName: string): Promise<PackageInstallPlan> {
  const src = await packageStage('Reading source object inventory', () => compareCatalog(source, input.sourceSchema));
  const dst = await packageStage('Reading target object inventory', () => compareCatalog(target, input.targetSchema));
  const closure = await packageClosure(source, src, input.packages);
  const generating = input.seedTables !== undefined;
  const targetKeys = new Set(dst.objects.map(key));
  const rootNames = new Set(input.packages);
  // Discovery uses dictionary presence only. Retained dependencies never need DDL or SXML diff.
  const toScript = generating ? closure.objects.filter(o => !targetKeys.has(key(o)) || rootNames.has(o.name) && /^(PACKAGE|PACKAGE BODY)$/.test(o.type)) : [];
  const differences = toScript.length ? await packageStage('Extracting deployment DDL', () => compareSchemaObjects(source, target, { ...input, objects: toScript, compareData: false, includeStorage: false }, src, dst)) : [];
  const scripted = new Set(differences.map(o => o.key));
  for (const o of closure.objects) if (!scripted.has(key(o))) {
    differences.push({ ...o, key: key(o), status: targetKeys.has(key(o)) ? 'same' : 'sourceOnly', sourceDdl: '', targetDdl: '', script: '', definitionCompared: false } as SchemaDifference);
  }
  const byKey = new Map(differences.map(o => [o.key, o]));
  const objects = closure.objects.map(o => byKey.get(key(o))!);
  const codeNames = [...new Set(closure.objects.filter(o => ['PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER'].includes(o.type)).map(o => o.name))];
  const codeBinds = Object.fromEntries(codeNames.map((name, i) => [`n${i}`, name]));
  const sourceRows = codeNames.length ? await boundedRows(source, `SELECT name, type, line, text FROM all_source WHERE owner = :owner AND name IN (${codeNames.map((_, i) => `:n${i}`).join(',')}) AND type IN ('PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER') ORDER BY name, type, line`, { owner: input.sourceSchema, ...codeBinds }) : [];
  const texts = new Map<string, { name: string; text: string }>();
  for (const r of sourceRows) {
    const k = key(obj(r.NAME, r.TYPE));
    if (!byKey.has(k)) continue;
    const text = texts.get(k) ?? { name: `${r.TYPE} ${r.NAME}`, text: "" };
    text.text += String(r.TEXT); texts.set(k, text);
  }
  const suggestions = closure.objects.filter(o => o.type === "TABLE").map(o => tableUsage(o.name, [...texts.values()], input.sourceSchema));
  const warnings = [...closure.warnings, 'Existing dependency definitions are retained without DDL comparison. Use Object comparison to review definition differences.', "Static dictionary dependencies do not cover all dynamic SQL, runtime names, conditional paths or privileges. Review external prerequisites, source code and target compilation errors."];
  const localPrerequisites = closure.prerequisites.filter(r => !r.REFERENCED_LINK_NAME);
  if (localPrerequisites.length > 500) throw new Error("More than 500 external prerequisites; narrow the package selection before target verification.");
  if (localPrerequisites.length) {
    const binds: Record<string, string> = {};
    const predicates = localPrerequisites.map((r, i) => {
      binds[`owner${i}`] = String(r.REFERENCED_OWNER); binds[`name${i}`] = String(r.REFERENCED_NAME); binds[`type${i}`] = String(r.REFERENCED_TYPE);
      return `(owner = :owner${i} AND object_name = :name${i} AND object_type = :type${i})`;
    });
    const visible = await compareRows(target, `SELECT owner, object_name, object_type, status FROM all_objects WHERE ${predicates.join(' OR ')}`, binds);
    for (const r of localPrerequisites) {
      const found = visible.find(v => v.OWNER === r.REFERENCED_OWNER && v.OBJECT_NAME === r.REFERENCED_NAME && v.OBJECT_TYPE === r.REFERENCED_TYPE);
      warnings.push(`Target external prerequisite ${r.REFERENCED_OWNER}.${r.REFERENCED_NAME} (${r.REFERENCED_TYPE}): ${found ? `visible, status ${found.STATUS}` : 'missing or not visible'}. Verify required direct grants separately.`);
    }
  }
  const seeds = [...new Set(input.seedTables ?? [])];
  if (seeds.some(name => !suggestions.some(s => s.table === name))) throw new Error("Select seed tables from the analyzed package dependency closure.");
  const exports: PackageInstallPlan["exports"] = [];
  let exportRows = 0, exportBytes = 0;
  for (const o of objects.filter(o => o.type === "TABLE" && seeds.includes(o.name))) {
    const startedAt = Date.now();
    try {
      const result = await exportSeedTable(source, target, input, o.name, dst.objects.some(t => key(t) === o.key));
      exportRows += result.rows; exportBytes += Buffer.byteLength(result.script);
      if (exportRows > 50000 || exportBytes > 20 * 1024 * 1024) throw new Error("Seed export exceeds the 50,000 row / 20 MiB script budget. Select fewer tables.");
      exports.push({ ...result, elapsedMs: Date.now() - startedAt });
    }
    catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const details = e instanceof SeedExportError ? e.details : undefined;
      const elapsedMs = Date.now() - startedAt;
      exports.push({ table: o.name, rows: 0, script: '', error, details, elapsedMs });
      console.error(JSON.stringify({ event: 'seed-export-failed', at: new Date().toISOString(), table: o.name, sourceSchema: input.sourceSchema, targetSchema: input.targetSchema, error, details, elapsedMs }));
    }
  }
  for (const o of objects) if (o.status === "error" || o.warning) warnings.push(`${o.type} ${o.name}: ${o.warning ?? "Metadata unavailable"}`);
  for (const e of exports) {
    if (e.error) warnings.push('Seed export ' + e.table + ': ' + e.error + (e.details ? ' [' + e.details.stage + '] ' + e.details.advice : ''));
    for (const w of e.warnings ?? []) warnings.push(e.table + ': ' + w);
  }
  const roots = new Set(input.packages);
  // Missing dependencies are installed; existing dependencies are retained. Selected packages are replaceable.
  const install = objects.filter(o => o.status === "sourceOnly" || roots.has(o.name) && /^(PACKAGE|PACKAGE BODY)$/.test(o.type) && o.status === "changed");
  for (const o of objects.filter(o => o.status === "changed" && !install.includes(o))) warnings.push(`Existing target dependency ${o.type} ${o.name} differs and is retained. Review compatibility or deploy its changes with Object comparison.`);
  for (const o of objects.filter(o => o.type === "TRIGGER" && install.includes(o))) warnings.push(`Missing trigger ${o.name} will be created before seed INSERTs; review its side effects.`);
  const lines = ["-- Oracle DataForge: package install (review before execution)", `-- ${cleanComment(sourceName)} / ${cleanComment(input.sourceSchema)} -> ${cleanComment(targetName)} / ${cleanComment(input.targetSchema)}`,
    ...warnings.map(w => `-- REVIEW: ${cleanComment(w)}`),
    "SET DEFINE OFF", "SET SQLBLANKLINES ON", "WHENEVER SQLERROR EXIT SQL.SQLCODE ROLLBACK", `ALTER SESSION SET CURRENT_SCHEMA = ${qi(input.targetSchema)};`];
  if (exports.some(e => e.error)) lines.push("-- INCOMPLETE EXPORT: resolve failed tables before deployment.", "BEGIN RAISE_APPLICATION_ERROR(-20002, 'Seed export incomplete; review the export log and regenerate.'); END;\n/");
  // Safe column widening precedes object compilation; identity preparation follows creation DDL.
  for (const e of exports) if (e.schemaSql?.length) lines.push(`-- Widen existing target columns for seed ${cleanComment(e.table)}.`, ...e.schemaSql);
  for (const o of install) if (o.script) lines.push(`-- ${cleanComment(o.type)} ${cleanComment(o.name)}`, o.script);
  const compilable = install.filter(o => /^(PACKAGE|PACKAGE BODY|TYPE|TYPE BODY|PROCEDURE|FUNCTION|VIEW|TRIGGER)$/.test(o.type) && o.script);
  if (compilable.length) {
    const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const matches = compilable.map(o => `(object_name = ${literal(o.name)} AND object_type = ${literal(o.type)})`).join(' OR ');
    lines.push(`-- Stop before seed data if Oracle created invalid objects. Inspect ALL_ERRORS and resolve cycles.\nDECLARE invalid_count PLS_INTEGER;\nBEGIN\n  SELECT COUNT(*) INTO invalid_count FROM all_objects WHERE owner = ${literal(input.targetSchema)} AND status <> 'VALID' AND (${matches});\n  IF invalid_count > 0 THEN RAISE_APPLICATION_ERROR(-20001, 'Install has invalid objects; review ALL_ERRORS before loading seed data.'); END IF;\nEND;\n/`);
  }
  const identityPreparation = exports.flatMap(e => e.preparationSql ?? []);
  const identityFinalization = exports.flatMap(e => e.finalizeSql ?? []);
  if (identityPreparation.length) lines.push('-- Identity preparation DDL (before all seed data).', ...identityPreparation);
  for (const e of exports) lines.push(`-- Seed ${cleanComment(e.table)} (${e.rows} source rows)${e.error ? ` REVIEW: ${cleanComment(e.error)}` : ""}`, e.script);
  const commitsSeedData = identityFinalization.length > 0;
  if (commitsSeedData) lines.push('-- Identity finalization requires committing seed data before DDL. Review before execution.', 'COMMIT;', ...identityFinalization);
  const identityRecoveryScript = commitsSeedData ? ['-- Recovery after an interrupted identity seed install.', '-- Rolls back uncommitted seed data before restoring identity modes and sequence settings.', '-- Run only after reviewing the failed install. Already committed data is preserved.', 'WHENEVER SQLERROR CONTINUE', 'ROLLBACK;', ...identityFinalization].join('\n') + '\n' : undefined;
  lines.push('-- Review existing target triggers and foreign keys before running INSERTs.', commitsSeedData ? '-- Seed data was explicitly committed for identity finalization.' : '-- Explicit COMMIT required after reviewing seed data. DDL above commits implicitly.', '-- Verify target ALL_OBJECTS.STATUS and ALL_ERRORS; Oracle can create invalid PL/SQL without stopping the script.');
  return { sourceName, targetName, sourceSchema: input.sourceSchema, targetSchema: input.targetSchema, comparedAt: new Date().toISOString(), roots: input.packages, objects,
    dependencies: closure.objects.map(o => ({ object: o, requires: closure.edges.get(key(o)) ?? [] })), suggestions, warnings, exports, commitsSeedData, identityRecoveryScript, script: lines.join("\n\n") + "\n" };
}
