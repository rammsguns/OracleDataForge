/**
 * Plain-language guidance for Oracle compile diagnostics.
 *
 * `user_errors` tells you what the compiler refused to accept, not what to do about
 * it — and the most common PL/SQL errors point at a line that is not the line with
 * the mistake (PLS-00103 in particular). These hints are a local lookup: instant, no
 * provider needed, and they cover the diagnostics that actually show up day to day.
 * Anything not in the table is left to Oracle's compiler diagnostics and manual review.
 */

export interface PlsqlHint {
  /** the diagnostic this was matched on, e.g. "PLS-00201" */
  code: string;
  /** what the compiler is complaining about */
  meaning: string;
  /** the concrete thing to try */
  fix: string;
}

/** `fix` may be a function when naming the offending identifier makes the advice sharper. */
type Rule = {
  meaning: string;
  fix: string | ((subject: string) => string);
};

/** Oracle quotes identifiers with '…' and symbols with "…" in diagnostic text. */
function subjectOf(text: string): string {
  const single = /'([^']{1,60})'/.exec(text);
  if (single) return single[1];
  const dbl = /"([^"]{1,60})"/.exec(text);
  return dbl ? dbl[1] : "";
}

const RULES: Record<string, Rule> = {
  "PLS-00103": {
    meaning: "Syntax error — the parser reached something it cannot make sense of here.",
    fix: (s) =>
      `The mistake is usually on the line *above* the one flagged: a missing \`;\`, an unclosed \`(\`, \`=\` where \`:=\` was meant, or a stray keyword${
        s ? ` before \`${s}\`` : ""
      }. Check the previous non-blank line first.`,
  },
  "PLS-00201": {
    meaning: "The compiler cannot see that name from inside this unit.",
    fix: (s) =>
      `Check the spelling and that ${s ? `\`${s}\`` : "it"} really exists in this schema. If it belongs to another schema, privileges must be granted **directly** to your user — roles are ignored inside stored PL/SQL. If it was meant to be a local variable, declare it.`,
  },
  "PLS-00202": {
    meaning: "A type name used here is not declared.",
    fix: (s) => `Declare the type, qualify it (\`OWNER.${s || "TYPE_NAME"}\`), or use \`%TYPE\` / \`%ROWTYPE\` to borrow it from a column or table.`,
  },
  "PLS-00215": {
    meaning: "A string length constraint is out of range.",
    fix: "VARCHAR2 in PL/SQL allows 1..32767 and 1..4000 in SQL. Give the declaration an explicit valid length.",
  },
  "PLS-00221": {
    meaning: "The name is being called as a procedure but is not one.",
    fix: (s) => `${s ? `\`${s}\`` : "It"} may be a function (assign its result instead of calling it as a statement), a variable, or misspelled. Check the package spec for the real signature.`,
  },
  "PLS-00222": {
    meaning: "No function with that name is visible in this scope.",
    fix: (s) => `Check the spelling and the package qualifier. If ${s ? `\`${s}\`` : "it"} is overloaded, the argument types may not match any version — compare against the spec.`,
  },
  "PLS-00302": {
    meaning: "The package or record does not have that member.",
    fix: (s) =>
      `${s ? `\`${s}\`` : "That member"} is missing from the package **specification** (or the record type). Add it to the spec and compile the spec first — a body-only change is invisible to callers.`,
  },
  "PLS-00306": {
    meaning: "The call does not match the declaration: wrong number or types of arguments.",
    fix: (s) =>
      `Compare the call against the declaration of ${s ? `\`${s}\`` : "the subprogram"} — count, order and datatypes must all line up. Named notation (\`p_id => v_id\`) makes the mismatch obvious and survives later signature changes.`,
  },
  "PLS-00320": {
    meaning: "The type of this expression is incomplete or malformed.",
    fix: "Usually a `%TYPE` / `%ROWTYPE` pointing at a table or column that does not exist (or a typo in the type name). Check that the referenced object is visible from this schema.",
  },
  "PLS-00323": {
    meaning: "Something declared in the package spec has no implementation in the body.",
    fix: (s) =>
      `Add ${s ? `\`${s}\`` : "the missing subprogram"} to the package **body**. The signature must match the spec exactly — parameter names, order, datatypes and defaults included.`,
  },
  "PLS-00363": {
    meaning: "You are assigning to something that cannot be assigned to.",
    fix: (s) =>
      `${s ? `\`${s}\`` : "The target"} is read-only — an \`IN\` parameter, a function result, a literal, or \`:OLD\` in a trigger. Use an \`OUT\` / \`IN OUT\` parameter or a local variable instead.`,
  },
  "PLS-00372": {
    meaning: "A trigger is trying to change `:NEW` where that is not allowed.",
    fix: "`:NEW.col` is only assignable in a **BEFORE** row trigger on INSERT or UPDATE. In AFTER or statement-level triggers the values are already fixed.",
  },
  "PLS-00382": {
    meaning: "Datatype mismatch — the expression is not the type expected here.",
    fix: "Add an explicit conversion (`TO_NUMBER` / `TO_CHAR` / `TO_DATE`) or declare the variable with `%TYPE` so it always matches the column it holds.",
  },
  "PLS-00385": {
    meaning: "Type mismatch in the index variable of a FOR loop.",
    fix: "A numeric `FOR i IN 1..n` loop needs numeric bounds; for a cursor loop use `FOR rec IN cursor_name LOOP` without a range.",
  },
  "PLS-00386": {
    meaning: "Type mismatch between a `FETCH … INTO` target and the cursor's select list.",
    fix: "Fetch into a `cursor%ROWTYPE` record instead of individual variables — it stays correct when the select list changes.",
  },
  "PLS-00394": {
    meaning: "The number of `INTO` targets does not match the select list.",
    fix: "Count the columns in the SELECT and the variables after `INTO` — they must match exactly, in order.",
  },
  "PLS-00404": {
    meaning: "`WHERE CURRENT OF` needs a cursor declared `FOR UPDATE`.",
    fix: (s) => `Add \`FOR UPDATE\` to the declaration of ${s ? `\`${s}\`` : "the cursor"}, or update by primary key instead.`,
  },
  "PLS-00428": {
    meaning: "A SELECT inside PL/SQL must put its result somewhere.",
    fix: "Add an `INTO`: `SELECT col INTO v_col FROM …`. For multiple rows use a cursor loop or `BULK COLLECT INTO` a collection.",
  },
  "PLS-00456": {
    meaning: "The name is used as a cursor but is not one.",
    fix: (s) => `${s ? `\`${s}\`` : "It"} is probably a variable or a ref cursor used the wrong way. Declare it with \`CURSOR ${s || "c"} IS SELECT …\`.`,
  },
  "PLS-00483": {
    meaning: "The same exception appears in more than one handler.",
    fix: "Merge the duplicate `WHEN` clauses — an exception can only be handled once per block. Use `WHEN a OR b THEN` to share a handler.",
  },
  "PLS-00593": {
    meaning: "A default value must be declared in the package specification too.",
    fix: "Parameter defaults belong in the spec. Repeat the same default in both places, or drop it from the body.",
  },
  "PLS-00905": {
    meaning: "A dependency of this unit is itself INVALID.",
    fix: (s) =>
      `Open ${s ? `\`${s}\`` : "the referenced object"} and compile it first — its own error list is where the real problem is. This unit will usually compile once the dependency is valid.`,
  },
  "PLS-00707": {
    meaning: "Unsupported construct or internal error.",
    fix: "Usually a feature the current compilation setting rejects. Simplify the statement; if it involves a deprecated construct, rewrite it in modern PL/SQL.",
  },
  "ORA-00904": {
    meaning: "A column name in a SQL statement does not exist.",
    fix: (s) =>
      `${s ? `\`${s}\`` : "That column"} is not on the table being queried — check the spelling, the alias prefix, and whether you meant a different table. Quoted mixed-case columns must be quoted everywhere.`,
  },
  "ORA-00907": {
    meaning: "Missing right parenthesis.",
    fix: "Unbalanced brackets, or a clause the parser rejected inside them (a common cause is a keyword that isn't valid in a subquery). Count the parentheses on the flagged line.",
  },
  "ORA-00922": {
    meaning: "Missing or invalid option in a DDL statement.",
    fix: "Usually a typo in a datatype or a misplaced keyword in the declaration — check the column/parameter list on the flagged line.",
  },
  "ORA-00933": {
    meaning: "The SQL command did not end where Oracle expected.",
    fix: "Often a clause in the wrong order (`ORDER BY` before `WHERE`), a stray comma, or a keyword that doesn't belong in this statement type.",
  },
  "ORA-00942": {
    meaning: "A table or view referenced by a SQL statement does not exist — or is not visible.",
    fix: "Check the name and the schema. Inside stored PL/SQL, privileges only count when granted **directly** to the owner of the unit; a grant via a role compiles fine interactively and fails here.",
  },
  "ORA-01722": {
    meaning: "Invalid number — a string is being converted to a number implicitly.",
    fix: "Find the comparison or assignment mixing text and numbers and make the conversion explicit with `TO_NUMBER`, or fix the datatype of the variable.",
  },
  "ORA-06550": {
    meaning: "A wrapper around the real PL/SQL error.",
    fix: "Read the `PLS-…` code that follows it on the same or the next line — that one names the actual problem.",
  },
  "PLW-05004": {
    meaning: "Warning: this identifier is also declared in an outer scope.",
    fix: "Shadowing compiles but hides bugs. Rename the inner declaration (a `v_` / `l_` prefix convention avoids this).",
  },
  "PLW-05018": {
    meaning: "Warning: the unit was compiled without a matching specification.",
    fix: "Harmless for standalone units. For a package, make sure you compiled the spec before the body.",
  },
  "PLW-06002": {
    meaning: "Warning: unreachable code.",
    fix: "Statements after `RETURN`, `EXIT` or `RAISE` never run. Usually a logic slip worth looking at even though it compiles.",
  },
  "PLW-06009": {
    meaning: "Warning: the `WHEN OTHERS` handler does not re-raise.",
    fix: "Swallowing every exception hides real failures. End the handler with `RAISE;` or `RAISE_APPLICATION_ERROR(…)` after logging.",
  },
  "PLW-07203": {
    meaning: "Warning: a large parameter could be passed `NOCOPY`.",
    fix: "Performance only. Add `NOCOPY` to the `OUT` / `IN OUT` parameter if copying the collection or LOB is measurably expensive.",
  },
};

/**
 * Look up guidance for one diagnostic line. Returns null when nothing useful is
 * known — better an empty space than filler text that says "check your code".
 */
export function hintForError(text: string): PlsqlHint | null {
  const m = /\b(PLS|ORA|PLW)-(\d{5})\b/.exec(text);
  if (!m) return null;
  const code = `${m[1]}-${m[2]}`;
  const rule = RULES[code];
  if (rule) {
    const subject = subjectOf(text);
    return { code, meaning: rule.meaning, fix: typeof rule.fix === "function" ? rule.fix(subject) : rule.fix };
  }
  // Warnings are the one category worth a generic note: people treat them as failures.
  if (m[1] === "PLW") {
    return {
      code,
      meaning: "This is a warning, not an error — the object did compile.",
      fix: "Worth fixing for cleanliness, but nothing is broken. Oracle's message text explains the specific concern.",
    };
  }
  return null;
}
