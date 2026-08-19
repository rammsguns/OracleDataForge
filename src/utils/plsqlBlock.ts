/** Generator for the editable PL/SQL block in the Run / Test tab — SQL Developer's
 *  "Run PL/SQL" dialog: locals declared from the signature, the parameter grid's values
 *  written in as literals, the call in named notation, and `:NAME` binds carrying the OUT
 *  values back. Once the user edits the block it is theirs: the backend runs the text
 *  verbatim, so anything PL/SQL accepts (loops, composite types, extra logic) works. */

import type { RoutineMember, RoutineMeta, RoutineParam } from "./api";
import type { ArgState } from "./runBuffers";

const PLAIN_IDENT = /^[A-Za-z][A-Za-z0-9_$#]*$/;

/** Dictionary names are unquoted uppercase; a lowercase or exotic one needs its quotes back. */
const ident = (n: string) => (PLAIN_IDENT.test(n) && n === n.toUpperCase() ? n : `"${n.replace(/"/g, "")}"`);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Render one form value as PL/SQL source.
 *
 * Text that parses as the declared type becomes a literal; text that doesn't is written
 * through untouched, so `SYSDATE`, `v_id + 1` or `T_ADDRESS('Main St')` stay usable — the
 * block is source code being authored, not a value being bound. Strings are always quoted:
 * an unquoted word is far more often a value than an expression.
 */
export function plsqlValue(p: RoutineParam, a: ArgState): string {
  const raw = a.value.trim();
  // a type we can't bind has no meaningful NULL either (a RECORD cannot even be assigned
  // one) — whatever the user typed is source, and the caller emits a TODO when it is empty
  if (!p.bindKind) return raw || "NULL";
  if (a.isNull) return "NULL";
  if (!raw) return p.bindKind === "string" ? "''" : "NULL";
  switch (p.bindKind) {
    case "number":
      return raw; // a number is already its own literal, and anything else is an expression
    case "boolean": {
      const t = raw.toLowerCase();
      if (["true", "t", "y", "yes", "1"].includes(t)) return "TRUE";
      if (["false", "f", "n", "no", "0"].includes(t)) return "FALSE";
      return raw;
    }
    case "date": {
      const m = raw.match(DATE_RE);
      if (!m) return raw;
      const stamp = `${m[1]}-${m[2]}-${m[3]} ${m[4] ?? "00"}:${m[5] ?? "00"}:${m[6] ?? "00"}`;
      return `TO_DATE('${stamp}', 'YYYY-MM-DD HH24:MI:SS')`;
    }
    case "cursor":
      return "NULL";
    default:
      return `'${raw.replace(/'/g, "''")}'`;
  }
}

/** Build the block for one member with the current form values. */
export function generateRoutineBlock(
  meta: RoutineMeta,
  member: RoutineMember,
  argOf: (p: RoutineParam) => ArgState
): string {
  const isPkg = meta.type === "PACKAGE";
  const isFn = member.kind === "FUNCTION";
  const target = isPkg ? `${ident(meta.name)}.${ident(member.name)}` : ident(meta.name);

  // a parameter left on "Default" is omitted from the call so its declared DEFAULT applies
  const used = member.params.filter((p) => !(p.hasDefault && argOf(p).useDefault));
  const omitted = member.params.filter((p) => p.hasDefault && argOf(p).useDefault);

  const taken = new Set(member.params.map((p) => p.name.toUpperCase()));
  const free = (base: string) => {
    let n = base;
    for (let i = 2; taken.has(n); i++) n = `${base}_${i}`;
    taken.add(n);
    return n;
  };
  const resultVar = isFn ? free("V_RESULT") : "";
  const resultBind = isFn ? free("RESULT") : "";

  const decls: [string, string][] = used.map((p) => [ident(p.name), p.declType]);
  if (isFn) decls.push([resultVar, member.returnDeclType ?? "VARCHAR2(32767)"]);
  const pad = decls.reduce((w, [n]) => Math.max(w, n.length), 0);

  const out: string[] = [];
  if (decls.length) {
    out.push("DECLARE");
    for (const [n, t] of decls) out.push(`  ${n.padEnd(pad)}  ${t};`);
  }
  out.push("BEGIN");

  const assigned = used.filter((p) => p.direction !== "OUT");
  for (const p of assigned) {
    const a = argOf(p);
    // a composite with no value yet gets a TODO instead of a wrong assignment: only the
    // author knows how to build a record or object, and `:= NULL` would not even compile
    if (!p.bindKind && !a.value.trim()) {
      out.push(`  -- ${ident(p.name)} := …;  -- build the ${p.declType} value here`);
      continue;
    }
    out.push(`  ${ident(p.name).padEnd(pad)} := ${plsqlValue(p, a)};`);
  }
  for (const p of omitted) out.push(`  -- ${p.name} omitted — its declared DEFAULT applies`);
  if (assigned.length || omitted.length) out.push("");

  const head = isFn ? `  ${resultVar} := ${target}` : `  ${target}`;
  if (!used.length) out.push(`${head};`);
  else {
    out.push(`${head}(`);
    out.push(used.map((p) => `    ${ident(p.name)} => ${ident(p.name)}`).join(",\n"));
    out.push("  );");
  }

  // `:NAME` placeholders are OUT binds: this is how the values reach the result panel
  const back = used.filter((p) => p.direction !== "IN");
  if (back.length || isFn) {
    out.push("");
    for (const p of back) out.push(`  :${p.name} := ${ident(p.name)};`);
    if (isFn) out.push(`  :${resultBind} := ${resultVar};`);
  }

  out.push("");
  out.push("  -- ROLLBACK;  -- uncomment to undo this block (code that COMMITs itself cannot be undone)");
  out.push("END;");
  return out.join("\n");
}
