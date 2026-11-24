import oracledb from "oracledb";
import { retargetSchema } from "./objectCopy.ts";
import { compareObjectKey, quoteCompareIdentifier as qi, type CompareCatalog, type CompareObject, type DataDifference, type SchemaCompareRequest, type SchemaDifference } from "../src/utils/schemaCompare.ts";

type Row = Record<string, unknown>;
export async function compareRows(conn: oracledb.Connection, sql: string, binds: oracledb.BindParameters = {}): Promise<Row[]> {
  const r = await conn.execute<Row>(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 20001 });
  return r.rows ?? [];
}
export function compareSchema(value: unknown, fallback: string): string {
  const s = String(value || fallback).trim();
  if (/^"(?:[^"]|"")+"$/.test(s)) return s.slice(1, -1).replace(/""/g, '"');
  if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(s)) throw new Error("Enter a valid schema name (quote case-sensitive names).");
  return s.toUpperCase();
}
export async function compareCatalog(conn: oracledb.Connection, schema: string): Promise<CompareCatalog> {
  const exists = await compareRows(conn, "SELECT username FROM all_users WHERE username = :owner", { owner: schema });
  if (!exists.length) throw new Error(`Schema ${schema} does not exist or is not visible.`);
  const rows = await compareRows(conn, `SELECT object_name, object_type FROM all_objects
    WHERE owner = :owner AND subobject_name IS NULL AND generated = 'N'
      AND object_name NOT LIKE 'BIN$%'
      AND (object_type <> 'TABLE' OR object_name NOT IN
        (SELECT mview_name FROM all_mviews WHERE owner = :owner))
      ORDER BY object_type, object_name`, { owner: schema });
  if (rows.length > 20000) throw new Error("Schema has more than 20,000 objects; narrow the schema before comparing.");
  const objects = rows.map(r => ({ name: String(r.OBJECT_NAME), type: String(r.OBJECT_TYPE) }));
  return { schema, objects, types: [...new Set(objects.map(o => o.type))] };
}
const metadataTypes: Record<string, string> = {
  TABLE: "TABLE", VIEW: "VIEW", "MATERIALIZED VIEW": "MATERIALIZED_VIEW", INDEX: "INDEX", SEQUENCE: "SEQUENCE",
  PROCEDURE: "PROCEDURE", FUNCTION: "FUNCTION", PACKAGE: "PACKAGE_SPEC", "PACKAGE BODY": "PACKAGE_BODY",
  TYPE: "TYPE_SPEC", "TYPE BODY": "TYPE_BODY", TRIGGER: "TRIGGER", SYNONYM: "SYNONYM", "DATABASE LINK": "DB_LINK",
  CLUSTER: "CLUSTER", DIMENSION: "DIMENSION", "JAVA SOURCE": "JAVA_SOURCE", "JAVA CLASS": "JAVA_CLASS",
};
const replaceable = new Set(["VIEW", "PROCEDURE", "FUNCTION", "PACKAGE", "PACKAGE BODY", "TYPE BODY", "TRIGGER", "SYNONYM", "JAVA SOURCE"]);
const alterable = new Set(["TABLE", "INDEX", "SEQUENCE", "TYPE", "MATERIALIZED VIEW", "CLUSTER"]);
const rank = ["CLUSTER", "TYPE", "SEQUENCE", "TABLE", "INDEX", "PACKAGE", "FUNCTION", "PROCEDURE", "VIEW", "MATERIALIZED VIEW", "TYPE BODY", "PACKAGE BODY", "SYNONYM", "TRIGGER"];

async function clobOutput(conn: oracledb.Connection, sql: string, binds: oracledb.BindParameters): Promise<string> {
  const result = await conn.execute(sql, { ...binds, output: { dir: oracledb.BIND_OUT, type: oracledb.CLOB } });
  const v = (result.outBinds as { output?: oracledb.Lob | string | null }).output;
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return String(await v.getData()); } finally { await v.close().catch(() => {}); }
}

/** Per-handle transforms avoid changing pooled sessions' metadata configuration. */
export async function readCompareDdl(conn: oracledb.Connection, o: CompareObject, schema: string, storage: boolean): Promise<string> {
  return readCompareDocument(conn, o, schema, storage, "DDL");
}
async function readCompareDocument(conn: oracledb.Connection, o: CompareObject, schema: string, storage: boolean, format: "DDL" | "SXML"): Promise<string> {
  const kind = metadataTypes[o.type];
  if (!kind) throw new Error(`Metadata scripting for ${o.type} is not supported; compare this type manually.`);
  return clobOutput(conn, `DECLARE h NUMBER; t NUMBER;
    BEGIN
      h := DBMS_METADATA.OPEN(:kind);
      DBMS_METADATA.SET_FILTER(h, 'SCHEMA', :owner);
      DBMS_METADATA.SET_FILTER(h, 'NAME', :name);
      t := DBMS_METADATA.ADD_TRANSFORM(h, '${format}');
      ${format === "DDL" ? "DBMS_METADATA.SET_TRANSFORM_PARAM(t, 'SQLTERMINATOR', TRUE);" : ""}
      ${["TABLE", "INDEX", "MATERIALIZED VIEW", "CLUSTER"].includes(o.type) ? `DBMS_METADATA.SET_TRANSFORM_PARAM(t, '${format === "SXML" && o.type !== "CLUSTER" ? "PHYSICAL_PROPERTIES" : "SEGMENT_ATTRIBUTES"}', ${storage ? "TRUE" : "FALSE"});` : ""}
      :output := DBMS_METADATA.FETCH_CLOB(h);
      DBMS_METADATA.CLOSE(h);
    EXCEPTION WHEN OTHERS THEN IF h IS NOT NULL THEN DBMS_METADATA.CLOSE(h); END IF; RAISE; END;`,
  { kind, owner: schema, name: o.name });
}
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
export function remapSxml(xml: string, from: string, to: string): string {
  const old = `<SCHEMA>${xmlEscape(from)}</SCHEMA>`;
  return xml.split(old).join(`<SCHEMA>${xmlEscape(to)}</SCHEMA>`);
}
async function alterScript(source: oracledb.Connection, target: oracledb.Connection, o: CompareObject, from: string, to: string, storage: boolean): Promise<string> {
  const kind = metadataTypes[o.type];
  const read = async (conn: oracledb.Connection, owner: string) => {
    const doc = await readCompareDocument(conn, o, owner, storage, "SXML");
    if (!doc) throw new Error("Oracle did not return SXML metadata.");
    return doc;
  };
  const src = remapSxml(await read(source, from), from, to);
  const dst = await read(target, to);
  // Oracle transforms the FIRST document into the SECOND: target first, desired source second.
  return clobOutput(target, `DECLARE c NUMBER; h NUMBER; t NUMBER; diffdoc CLOB; alterxml CLOB;
    BEGIN
      c := DBMS_METADATA_DIFF.OPENC(:kind);
      DBMS_METADATA_DIFF.ADD_DOCUMENT(c, :targetDoc);
      DBMS_METADATA_DIFF.ADD_DOCUMENT(c, :sourceDoc);
      diffdoc := DBMS_METADATA_DIFF.FETCH_CLOB(c);
      DBMS_METADATA_DIFF.CLOSE(c); c := NULL;
      h := DBMS_METADATA.OPENW(:kind);
      t := DBMS_METADATA.ADD_TRANSFORM(h, 'ALTERXML');
      DBMS_LOB.CREATETEMPORARY(alterxml, TRUE);
      DBMS_METADATA.CONVERT(h, diffdoc, alterxml);
      DBMS_METADATA.CLOSE(h); h := NULL;
      h := DBMS_METADATA.OPENW(:kind);
      t := DBMS_METADATA.ADD_TRANSFORM(h, 'ALTERDDL');
      DBMS_METADATA.SET_TRANSFORM_PARAM(t, 'SQLTERMINATOR', TRUE);
      DBMS_LOB.CREATETEMPORARY(:output, TRUE);
      DBMS_METADATA.CONVERT(h, alterxml, :output);
      DBMS_METADATA.CLOSE(h); h := NULL;
      DBMS_LOB.FREETEMPORARY(alterxml);
    EXCEPTION WHEN OTHERS THEN
      IF c IS NOT NULL THEN DBMS_METADATA_DIFF.CLOSE(c); END IF;
      IF h IS NOT NULL THEN DBMS_METADATA.CLOSE(h); END IF;
      IF DBMS_LOB.ISTEMPORARY(alterxml) = 1 THEN DBMS_LOB.FREETEMPORARY(alterxml); END IF;
      RAISE;
    END;`, { kind, sourceDoc: { val: src, type: oracledb.CLOB }, targetDoc: { val: dst, type: oracledb.CLOB } });
}

export const normalizeCompareDdl = (s: string) => s.replace(/\r\n/g, "\n").trim();
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

export async function compareSchemaObjects(source: oracledb.Connection, target: oracledb.Connection, req: SchemaCompareRequest,
  sourceCatalog: CompareCatalog, targetCatalog: CompareCatalog): Promise<SchemaDifference[]> {
  const src = new Set(sourceCatalog.objects.map(compareObjectKey));
  const dst = new Set(targetCatalog.objects.map(compareObjectKey));
  const selected = [...new Map(req.objects.map(o => [compareObjectKey(o), o])).values()];
  selected.sort((a, b) => (rank.indexOf(a.type) < 0 ? 99 : rank.indexOf(a.type)) - (rank.indexOf(b.type) < 0 ? 99 : rank.indexOf(b.type)) || a.name.localeCompare(b.name));
  const result: SchemaDifference[] = [];
  for (const o of selected) {
    const key = compareObjectKey(o);
    const item: SchemaDifference = { ...o, key, status: "same", sourceDdl: "", targetDdl: "", script: "" };
    result.push(item);
    try {
      if (!src.has(key) && !dst.has(key)) throw new Error("Object is no longer visible. Reload the object list.");
      if (src.has(key)) {
        item.sourceDdl = await readCompareDdl(source, o, req.sourceSchema, req.includeStorage);
        if (!item.sourceDdl.trim()) throw new Error("Source metadata is not accessible. Check DBMS_METADATA privileges.");
      }
      if (dst.has(key)) {
        item.targetDdl = await readCompareDdl(target, o, req.targetSchema, req.includeStorage);
        if (!item.targetDdl.trim()) throw new Error("Target metadata is not accessible. Check DBMS_METADATA privileges.");
      }
      const desired = retargetSchema(item.sourceDdl, req.sourceSchema, req.targetSchema, { exactCase: true });
      if (!src.has(key)) {
        item.status = "targetOnly";
        if (/^(TABLE|VIEW|MATERIALIZED VIEW|INDEX|SEQUENCE|PROCEDURE|FUNCTION|PACKAGE|PACKAGE BODY|TYPE|TYPE BODY|TRIGGER|SYNONYM|CLUSTER|DIMENSION)$/.test(o.type)) {
          item.script = `DROP ${o.type} ${qi(req.targetSchema)}.${qi(o.name)};`;
        } else item.warning = "Generate the removal script manually for this object type.";
      } else if (!dst.has(key)) { item.status = "sourceOnly"; item.script = desired; }
      else if (normalizeCompareDdl(desired) !== normalizeCompareDdl(item.targetDdl)) {
        item.status = "changed";
        if (replaceable.has(o.type)) item.script = desired;
        else if (alterable.has(o.type)) {
          try {
            item.script = retargetSchema(await alterScript(source, target, o, req.sourceSchema, req.targetSchema, req.includeStorage), req.sourceSchema, req.targetSchema, { exactCase: true });
            item.warning = "Oracle-generated ALTER statements may remove columns or constraints. Review all changes and dependencies.";
            if (!item.script.trim()) item.warning = "Oracle returned no ALTER statements for this DDL difference. Review definitions manually.";
          } catch (e) { item.warning = `Manual migration required: ${errorText(e)}`; }
        } else item.warning = "This definition cannot be replaced safely in place. Create a reviewed migration manually.";
      }
      if (req.compareData && o.type === "TABLE" && src.has(key) && dst.has(key)) {
        try { item.data = await compareTableData(source, target, req.sourceSchema, req.targetSchema, o.name, req.rowLimit); }
        catch (e) { item.data = emptyData("error", errorText(e)); }
      }
    } catch (e) { item.status = "error"; item.warning = errorText(e); }
  }
  return result;
}

type CellRow = Record<string, string | null>;
interface DataColumn { name: string; type: string }
const emptyData = (status: DataDifference["status"], message: string): DataDifference => ({ status, message, inserted: 0, updated: 0, deleted: 0, samples: [], script: "" });
const scalarTypes = /^(VARCHAR2|NVARCHAR2|CHAR|NCHAR|NUMBER|FLOAT|DATE|TIMESTAMP(?:\(\d+\))?(?: WITH TIME ZONE)?|RAW)$/;
function valueExpression(c: DataColumn): string {
  const name = qi(c.name);
  if (/^(NUMBER|FLOAT)$/.test(c.type)) return `TO_CHAR(${name}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')`;
  if (c.type === "DATE") return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS', 'NLS_DATE_LANGUAGE=English')`;
  if (c.type.startsWith("TIMESTAMP")) return `TO_CHAR(${name}, 'YYYY-MM-DD HH24:MI:SS.FF9${c.type.includes("TIME ZONE") ? " TZH:TZM" : ""}', 'NLS_DATE_LANGUAGE=English')`;
  if (c.type === "RAW") return `RAWTOHEX(${name})`;
  return name;
}
export function compareDataLiteral(v: string | null, type: string): string {
  if (v === null) return "NULL";
  // Short literal chunks stay below Oracle's byte limit; CHR avoids SQL*Plus line commands inside values.
  const national = /^(NCHAR|NVARCHAR2)$/.test(type);
  const parts: string[] = [];
  for (const segment of v.split(/([\r\n])/)) {
    if (segment === "\r" || segment === "\n") { parts.push(`CHR(${segment === "\r" ? 13 : 10})`); continue; }
    const chars = Array.from(segment);
    if (!chars.length) continue;
    for (let i = 0; i < chars.length; i += 500) parts.push(`${national ? "N" : ""}'${chars.slice(i, i + 500).join("").replace(/'/g, "''")}'`);
  }
  const str = parts.join(" || ") || "''";
  if (/^(NUMBER|FLOAT)$/.test(type)) {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][+-]?\d+)?$/.test(v)) throw new Error("Invalid numeric representation.");
    return v;
  }
  if (type === "DATE") return `TO_DATE(${str}, 'YYYY-MM-DD HH24:MI:SS', 'NLS_DATE_LANGUAGE=English')`;
  if (type.startsWith("TIMESTAMP")) return `${type.includes("TIME ZONE") ? "TO_TIMESTAMP_TZ" : "TO_TIMESTAMP"}(${str}, 'YYYY-MM-DD HH24:MI:SS.FF9${type.includes("TIME ZONE") ? " TZH:TZM" : ""}', 'NLS_DATE_LANGUAGE=English')`;
  if (type === "RAW") return `HEXTORAW(${str})`;
  return str;
}
export function diffCompareData(source: CellRow[], target: CellRow[], columns: DataColumn[], keys: string[], table: string): DataDifference {
  const key = (r: CellRow) => JSON.stringify(keys.map(k => r[k]));
  const src = new Map(source.map(r => [key(r), r]));
  const dst = new Map(target.map(r => [key(r), r]));
  if (src.size !== source.length || dst.size !== target.length) return emptyData("skipped", "Comparison keys are not unique.");
  const out = emptyData("same", "");
  const sql: string[] = [];
  const where = (r: CellRow) => keys.map(k => `${qi(k)} = ${compareDataLiteral(r[k], columns.find(c => c.name === k)!.type)}`).join(" AND ");
  const sample = (k: string, s: CellRow | null, t: CellRow | null) => { if (out.samples.length < 100) out.samples.push({ key: k, source: s, target: t }); };
  for (const [k, row] of src) {
    const old = dst.get(k);
    if (!old) {
      out.inserted++; sample(k, row, null);
      sql.push(`INSERT INTO ${table} (${columns.map(c => qi(c.name)).join(", ")}) VALUES (${columns.map(c => compareDataLiteral(row[c.name], c.type)).join(", ")});`);
    } else {
      const changed = columns.filter(c => row[c.name] !== old[c.name] && !keys.includes(c.name));
      if (changed.length) {
        out.updated++; sample(k, row, old);
        sql.push(`UPDATE ${table} SET ${changed.map(c => `${qi(c.name)} = ${compareDataLiteral(row[c.name], c.type)}`).join(", ")} WHERE ${where(old)};`);
      }
    }
  }
  // Child-first deletes may need a separate deployment phase; keep every table's deletes first.
  const deletes: string[] = [];
  for (const [k, row] of dst) if (!src.has(k)) { out.deleted++; sample(k, null, row); deletes.push(`DELETE FROM ${table} WHERE ${where(row)};`); }
  out.status = out.inserted + out.updated + out.deleted ? "different" : "same";
  out.message = `${out.inserted} source-only, ${out.updated} changed, ${out.deleted} target-only rows (by primary key).`;
  out.script = [...deletes, ...sql].join("\n");
  return out;
}
export async function compareTableData(source: oracledb.Connection, target: oracledb.Connection, from: string, to: string, name: string, limit: number): Promise<DataDifference> {
  const describe = async (conn: oracledb.Connection, owner: string) => compareRows(conn,
    `SELECT column_name, data_type, virtual_column, identity_column FROM all_tab_cols WHERE owner = :owner AND table_name = :name AND hidden_column = 'NO' ORDER BY column_id`, { owner, name });
  const a = await describe(source, from), b = await describe(target, to);
  if (JSON.stringify(a) !== JSON.stringify(b)) return emptyData("skipped", "Column layouts differ; deploy schema changes before comparing data.");
  const columns = a.map(r => ({ name: String(r.COLUMN_NAME), type: String(r.DATA_TYPE) }));
  if (!columns.length || columns.some(c => !scalarTypes.test(c.type))) return emptyData("skipped", "Data comparison supports scalar text, numeric, date, timestamp and RAW columns. LOBs and complex types require a dedicated comparison.");
  if (a.some(r => r.VIRTUAL_COLUMN === "YES" || r.IDENTITY_COLUMN === "YES")) return emptyData("skipped", "Tables with virtual or identity columns require a dedicated data migration.");
  const pk = async (conn: oracledb.Connection, owner: string) => (await compareRows(conn,
    `SELECT cc.column_name FROM all_constraints c JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name
     WHERE c.owner = :owner AND c.table_name = :name AND c.constraint_type = 'P' AND c.status = 'ENABLED' ORDER BY cc.position`, { owner, name })).map(r => String(r.COLUMN_NAME));
  const keys = await pk(source, from);
  if (!keys.length || JSON.stringify(keys) !== JSON.stringify(await pk(target, to))) return emptyData("skipped", "Both tables need the same enabled primary key for reliable row matching.");
  const fetch = async (conn: oracledb.Connection, owner: string) => await compareRows(conn,
    `SELECT ${columns.map(c => `${valueExpression(c)} AS ${qi(c.name)}`).join(", ")} FROM ${qi(owner)}.${qi(name)} ORDER BY ${keys.map(qi).join(", ")} FETCH FIRST ${limit + 1} ROWS ONLY`) as CellRow[];
  const src = await fetch(source, from), dst = await fetch(target, to);
  if (src.length > limit || dst.length > limit) return emptyData("limited", `More than ${limit.toLocaleString()} rows on at least one side. Increase the limit; no equality claim or data script was generated.`);
  return diffCompareData(src, dst, columns, keys, `${qi(to)}.${qi(name)}`);
}
