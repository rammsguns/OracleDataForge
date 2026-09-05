/**
 * Tests for the pure half of "copy objects to another connection". Run with `npm test`.
 *
 * Three things are worth pinning down, and none of them fails loudly in the app.
 *
 * **Terminator handling** is a keystroke either way. A `CREATE TABLE` that keeps its `;` and a
 * PL/SQL block that loses its `END;` fail with the same unhelpful syntax error, and both are
 * one character.
 *
 * **`retargetSchema`** is the failure mode that looks like a success: DDL still naming the
 * source schema is created, is VALID, and reads the source database from the target forever.
 * Its converse matters just as much — a rewrite that reaches into a string literal corrupts
 * data the user can see, so the literals are tested as carefully as the identifiers.
 *
 * **`normalizeKind`** is a whitelist over a request body, and whatever survives it decides
 * which DDL is read and run against a live database.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ALL_COPY_KINDS,
  copyBaseKinds,
  copyBaseLabel,
  copyCountLabel,
  copyIdent,
  copyKindSpec,
  copyMetadataType,
  copyStatements,
  copyTransforms,
  DEFAULT_COPY_KIND,
  dropStatement,
  isPlsqlDdl,
  normalizeKind,
  normalizeNames,
  OBJECT_COPY_KINDS,
  prepareDdl,
  retargetSchema,
  splitDdl,
} from "./objectCopy.ts";

describe("OBJECT_COPY_KINDS", () => {
  it("is what one run can copy, in the order the UI offers them", () => {
    assert.deepEqual(ALL_COPY_KINDS, ["sequences", "tables", "indexes", "views", "mviews", "triggers"]);
  });

  it("lists the kinds in the order they have to be copied in", () => {
    // a column default calling ORDER_SEQ.NEXTVAL fails with ORA-02289 when the sequence is not
    // there, and an index cannot be created before its table — so someone working down the
    // list in order gets a schema that comes out whole, and any other order does not
    assert.ok(ALL_COPY_KINDS.indexOf("sequences") < ALL_COPY_KINDS.indexOf("tables"));
    assert.ok(ALL_COPY_KINDS.indexOf("tables") < ALL_COPY_KINDS.indexOf("indexes"));
    // a view over a table that has not arrived is created, and created invalid
    assert.ok(ALL_COPY_KINDS.indexOf("tables") < ALL_COPY_KINDS.indexOf("views"));
    // and the kind that cannot recover goes after the kind that can: a view missing something
    // is created anyway and compiles itself later, a materialized view missing something fails
    assert.ok(ALL_COPY_KINDS.indexOf("views") < ALL_COPY_KINDS.indexOf("mviews"));
    // triggers after everything: one stands on the table or view it fires for *and* on
    // whatever its body calls, which is more than any other kind asks of the target
    for (const kind of ALL_COPY_KINDS.filter((k) => k !== "triggers")) {
      assert.ok(ALL_COPY_KINDS.indexOf(kind) < ALL_COPY_KINDS.indexOf("triggers"), kind);
    }
  });

  it("gives every kind a distinct label and a spec that can be looked up", () => {
    const labels = new Set(OBJECT_COPY_KINDS.map((k) => k.label));
    assert.equal(labels.size, OBJECT_COPY_KINDS.length);
    for (const kind of ALL_COPY_KINDS) assert.equal(copyKindSpec(kind).kind, kind);
  });

  it("names an Oracle object type for each kind, since that is what the target is checked for", () => {
    for (const spec of OBJECT_COPY_KINDS) assert.match(spec.objectType, /^[A-Z ]+$/);
  });

  it("gives DBMS_METADATA its own name for a kind the dictionary spells differently", () => {
    // user_objects says MATERIALIZED VIEW and GET_DDL wants MATERIALIZED_VIEW; the dictionary
    // spelling passed to GET_DDL earns an ORA-31600 that names the parameter, not the mistake
    assert.equal(copyKindSpec("mviews").objectType, "MATERIALIZED VIEW");
    assert.equal(copyMetadataType("mviews"), "MATERIALIZED_VIEW");
  });

  it("falls back to the dictionary's name for every kind that shares it", () => {
    for (const kind of ALL_COPY_KINDS.filter((k) => k !== "mviews")) {
      assert.equal(copyMetadataType(kind), copyKindSpec(kind).objectType, kind);
    }
  });

  it("never passes a DBMS_METADATA type with a space in it", () => {
    // the whole shape of the mistake: DBMS_METADATA's names are underscored, the dictionary's
    // are spaced, and one is being read from a variable that used to hold the other
    for (const kind of ALL_COPY_KINDS) assert.ok(!copyMetadataType(kind).includes(" "), kind);
  });

  it("offers the default as one of the kinds it lists", () => {
    assert.ok(ALL_COPY_KINDS.includes(DEFAULT_COPY_KIND));
  });

  it("marks tables as owning foreign keys, which is what runs the second pass", () => {
    // without it the copied tables come out with no referential integrity at all, which is a
    // difference nothing in the run reports
    assert.equal(copyKindSpec("tables").foreignKeys, true);
  });

  it("does not run the foreign-key pass for a kind that cannot own one", () => {
    // it would be a wasted pair of queries against the source at best, and the results it
    // reported would be about tables this run never touched
    assert.equal(copyKindSpec("indexes").foreignKeys, false);
  });

  it("offers the tablespace choice only for the kinds that occupy one", () => {
    // a sequence is a row in the dictionary and lives in no segment, so the checkbox is left
    // out for it rather than shown and quietly ignored — and the dialog drops the sentence too
    assert.equal(copyKindSpec("sequences").hasTablespace, false);
    assert.equal(copyKindSpec("views").hasTablespace, false);
    // and a trigger is PL/SQL in the dictionary, which occupies no segment either
    assert.equal(copyKindSpec("triggers").hasTablespace, false);
    assert.equal(copyKindSpec("tables").hasTablespace, true);
    assert.equal(copyKindSpec("indexes").hasTablespace, true);
    // a materialized view keeps its rows in a container table, which is a segment like any other
    assert.equal(copyKindSpec("mviews").hasTablespace, true);
  });

  it("drops and rebuilds a materialized view rather than replacing it in place", () => {
    // there is no CREATE OR REPLACE MATERIALIZED VIEW, and the rows go with the drop — which
    // is why the kind's replace note is about a rebuild rather than a definition swap
    assert.equal(copyKindSpec("mviews").replaceInPlace, false);
    // and it fails outright rather than landing invalid, so there is nothing to check after
    assert.equal(copyKindSpec("mviews").compiled, false);
  });

  it("replaces a view in place, and everything else by dropping it first", () => {
    // DBMS_METADATA emits CREATE OR REPLACE for a view, so a DROP first would cost the grants
    // on it and the validity of every view built on it, to make room for a statement that was
    // going to overwrite it anyway
    assert.equal(copyKindSpec("views").replaceInPlace, true);
    // a trigger is the same statement and the same reasoning: dropping it first would leave
    // the table unguarded for as long as the create takes, for no gain at all
    assert.equal(copyKindSpec("triggers").replaceInPlace, true);
    for (const kind of ALL_COPY_KINDS.filter((k) => k !== "views" && k !== "triggers")) {
      assert.equal(copyKindSpec(kind).replaceInPlace, false, kind);
    }
  });

  it("marks views as compiled, which is what checks the target for invalid ones afterwards", () => {
    // a view is created FORCE — it lands whether or not the target has what it selects from,
    // so without the check a run reports "created" for a view that raises ORA-04063
    assert.equal(copyKindSpec("views").compiled, true);
    // a trigger lands the same way when its body calls something the target has not got: it
    // exists, it is invalid, and the first insert on the table is what finds out
    assert.equal(copyKindSpec("triggers").compiled, true);
    for (const kind of ALL_COPY_KINDS.filter((k) => k !== "views" && k !== "triggers")) {
      assert.equal(copyKindSpec(kind).compiled, false, kind);
    }
  });

  it("asks nothing of a view but the schema it lands in", () => {
    // it is text, not a segment, and its dependencies are many and of many types — which is
    // why they are reported after the fact rather than pre-checked the way an index's one
    // base table is
    assert.equal(copyKindSpec("views").foreignKeys, false);
    assert.equal(copyKindSpec("views").requiresTable, false);
  });

  it("asks nothing extra of a sequence, which stands on its own", () => {
    assert.equal(copyKindSpec("sequences").foreignKeys, false);
    assert.equal(copyKindSpec("sequences").requiresTable, false);
  });

  it("marks indexes as built on a table, which is what checks the target for one first", () => {
    // without it a whole run of indexes fails with ORA-00942 naming neither the index nor the
    // table it wanted; with it each one is a skip that names the table to copy across
    assert.equal(copyKindSpec("indexes").requiresTable, true);
    assert.equal(copyKindSpec("tables").requiresTable, false);
  });

  it("marks triggers as built on something, and on either of two kinds", () => {
    // an INSTEAD OF trigger is how a view is written to at all, so a run that looked only
    // among the target's tables would report every one of them as blocked by a view that is
    // sitting right there
    assert.equal(copyKindSpec("triggers").requiresTable, true);
    assert.deepEqual(copyKindSpec("triggers").baseKinds, ["tables", "views"]);
  });

  it("says what each kind carries and what replacing one costs", () => {
    // both are shown to the user verbatim — the note in the type list and in the confirmation
    // dialog, the replace note under the "drop and recreate" choice
    for (const spec of OBJECT_COPY_KINDS) {
      assert.ok(spec.note.length > 20, `${spec.kind} needs a note`);
      assert.ok(spec.replaceNote.length > 20, `${spec.kind} needs a replace note`);
    }
  });
});

describe("normalizeKind", () => {
  it("keeps a kind it recognises, however it was typed", () => {
    assert.equal(normalizeKind("tables"), "tables");
    assert.equal(normalizeKind(" TABLES "), "tables");
    assert.equal(normalizeKind("indexes"), "indexes");
    assert.equal(normalizeKind(" Indexes "), "indexes");
    assert.equal(normalizeKind("sequences"), "sequences");
    assert.equal(normalizeKind("views"), "views");
    assert.equal(normalizeKind("mviews"), "mviews");
    assert.equal(normalizeKind(" MVIEWS "), "mviews");
    assert.equal(normalizeKind("triggers"), "triggers");
    assert.equal(normalizeKind(" TRIGGERS "), "triggers");
  });

  it("falls back to the default rather than passing an unknown kind through", () => {
    // the value reaches a listing query that has no entry for it, so it must not survive
    assert.equal(normalizeKind("grants"), DEFAULT_COPY_KIND);
    // a kind this app does not copy is not a kind, however plausible it sounds
    assert.equal(normalizeKind("procedures"), DEFAULT_COPY_KIND);
    assert.equal(normalizeKind("synonyms"), DEFAULT_COPY_KIND);
  });

  it("falls back for anything that is not a string at all", () => {
    assert.equal(normalizeKind(undefined), DEFAULT_COPY_KIND);
    assert.equal(normalizeKind(["tables"]), DEFAULT_COPY_KIND);
    assert.equal(normalizeKind({ kind: "tables" }), DEFAULT_COPY_KIND);
    assert.equal(normalizeKind(7), DEFAULT_COPY_KIND);
  });
});

describe("normalizeNames", () => {
  const available = ["EMPLOYEES", "DEPARTMENTS", "JOBS"];

  it("keeps the names the source dictionary actually lists", () => {
    assert.deepEqual(normalizeNames(["JOBS", "EMPLOYEES"], available), ["EMPLOYEES", "JOBS"]);
  });

  it("returns them in dictionary order, not the order they were asked for", () => {
    assert.deepEqual(normalizeNames(["JOBS", "DEPARTMENTS", "EMPLOYEES"], available), available);
  });

  it("drops a name the source does not have", () => {
    // it reaches dbms_metadata.get_ddl and a DROP, so the listing is the whitelist
    assert.deepEqual(normalizeNames(["EMPLOYEES", "SYS.USER$", "GONE"], available), ["EMPLOYEES"]);
    assert.deepEqual(normalizeNames(["employees"], available), [], "the dictionary's case is the name's case");
  });

  it("distinguishes 'nothing was asked for' from 'nothing asked for exists'", () => {
    // null means the caller copies everything; an empty array means it copies nothing, and
    // falling back to everything there would copy a whole schema nobody asked for
    assert.equal(normalizeNames(undefined, available), null);
    assert.equal(normalizeNames("EMPLOYEES", available), null);
    assert.equal(normalizeNames({ names: ["EMPLOYEES"] }, available), null);
    assert.deepEqual(normalizeNames([], available), []);
    assert.deepEqual(normalizeNames(["NOTHING_LIKE_IT"], available), []);
  });

  it("ignores entries that are not names at all", () => {
    assert.deepEqual(normalizeNames([7, null, { name: "JOBS" }, "JOBS"], available), ["JOBS"]);
  });
});

describe("copyTransforms", () => {
  const paramsOf = (preserve: boolean) => Object.fromEntries(copyTransforms(preserve));

  it("never emits the source schema, whatever else it is asked for", () => {
    // the one that decides whether the copy creates its objects in the target or in the source
    for (const preserve of [true, false]) assert.equal(paramsOf(preserve).EMIT_SCHEMA, false);
  });

  it("keeps a table's own constraints and leaves its foreign keys out", () => {
    for (const preserve of [true, false]) {
      assert.equal(paramsOf(preserve).CONSTRAINTS, true);
      assert.equal(
        paramsOf(preserve).REF_CONSTRAINTS,
        false,
        "the parent table may not be copied yet — they are added in a second pass instead"
      );
    }
  });

  it("suppresses the whole segment clause when the tablespace is not preserved", () => {
    const off = paramsOf(false);
    assert.equal(off.TABLESPACE, false);
    assert.equal(off.SEGMENT_ATTRIBUTES, false);
  });

  it("turns on segment attributes with the tablespace, because one is inside the other", () => {
    // TABLESPACE=TRUE emits nothing at all while SEGMENT_ATTRIBUTES=FALSE suppresses the
    // clause it lives in, so the two only ever move together
    const on = paramsOf(true);
    assert.equal(on.TABLESPACE, true);
    assert.equal(on.SEGMENT_ATTRIBUTES, true);
  });

  it("leaves the storage sizing behind either way", () => {
    // where a table lives is a different question from how much room the source gave it
    for (const preserve of [true, false]) assert.equal(paramsOf(preserve).STORAGE, false);
  });
});

describe("splitDdl", () => {
  it("splits on the SQL*Plus slash, so one answer becomes the statements it holds", () => {
    const ddl = ["CREATE TABLE a (id NUMBER);", "/", "CREATE TABLE b (id NUMBER);", "/"].join("\n");
    const parts = splitDdl(ddl);
    assert.equal(parts.length, 2);
    assert.ok(parts[0].startsWith("CREATE TABLE a"));
    assert.ok(parts[1].startsWith("CREATE TABLE b"));
  });

  it("leaves a slash that is not alone on its line where it is", () => {
    const [only] = splitDdl("CREATE VIEW v AS SELECT a/b AS ratio FROM t;");
    assert.equal(only, "CREATE VIEW v AS SELECT a/b AS ratio FROM t;");
  });

  it("tolerates the CRLF a Windows client reads the CLOB back as", () => {
    assert.equal(splitDdl("CREATE TABLE t (id NUMBER);\r\n/\r\n").length, 1);
  });

  it("returns nothing for empty or slash-only text", () => {
    assert.deepEqual(splitDdl(""), []);
    assert.deepEqual(splitDdl("\n/\n"), []);
  });
});

describe("isPlsqlDdl", () => {
  it("recognises the statements whose last semicolon belongs to the block", () => {
    for (const sql of [
      "CREATE OR REPLACE PACKAGE BODY p AS END;",
      "CREATE PROCEDURE go IS BEGIN NULL; END;",
      "CREATE OR REPLACE NONEDITIONABLE FUNCTION f RETURN NUMBER IS BEGIN RETURN 1; END;",
      "CREATE OR REPLACE EDITIONABLE TRIGGER t BEFORE INSERT ON x BEGIN NULL; END;",
      "CREATE TYPE addr AS OBJECT (line VARCHAR2(80));",
      "BEGIN NULL; END;",
      "DECLARE x NUMBER; BEGIN NULL; END;",
    ]) {
      assert.ok(isPlsqlDdl(sql), sql);
    }
  });

  it("does not mistake plain DDL for PL/SQL", () => {
    for (const sql of [
      "CREATE TABLE t (id NUMBER);",
      "CREATE OR REPLACE VIEW v AS SELECT 1 FROM dual;",
      // what GET_DDL actually emits for a view: FORCE sits where EDITIONABLE would, and the
      // trailing semicolon is a terminator that has to go rather than the end of a block
      'CREATE OR REPLACE FORCE EDITIONABLE VIEW "ORDER_SUMMARY_V" ("ID", "TOTAL") AS SELECT id, total FROM orders;',
      "CREATE UNIQUE INDEX ix ON t (id);",
      "ALTER TABLE t ADD CONSTRAINT fk FOREIGN KEY (p) REFERENCES q (id);",
      "CREATE SEQUENCE s START WITH 1;",
    ]) {
      assert.ok(!isPlsqlDdl(sql), sql);
    }
  });

  it("is not fooled by a table whose name begins with a PL/SQL keyword", () => {
    assert.ok(!isPlsqlDdl("CREATE TABLE functions (id NUMBER);"));
    assert.ok(!isPlsqlDdl("CREATE TABLE package_runs (id NUMBER);"));
  });
});

describe("prepareDdl", () => {
  it("strips the terminator from plain DDL", () => {
    assert.equal(prepareDdl("CREATE TABLE t (id NUMBER);"), "CREATE TABLE t (id NUMBER)");
    assert.equal(prepareDdl("  CREATE TABLE t (id NUMBER) ;\n\n"), "CREATE TABLE t (id NUMBER)");
  });

  it("keeps the semicolon that ends a PL/SQL block", () => {
    const sql = "CREATE OR REPLACE PROCEDURE go IS BEGIN NULL; END;";
    assert.equal(prepareDdl(sql), sql);
  });

  it("strips the SQL*Plus slash that follows a block", () => {
    assert.equal(
      prepareDdl("CREATE OR REPLACE PROCEDURE go IS BEGIN NULL; END;\n/"),
      "CREATE OR REPLACE PROCEDURE go IS BEGIN NULL; END;"
    );
    assert.equal(prepareDdl("CREATE TYPE t AS OBJECT (a NUMBER);\n  /  "), "CREATE TYPE t AS OBJECT (a NUMBER);");
  });

  it("strips the terminator from the view DDL Oracle emits", () => {
    const ddl = 'CREATE OR REPLACE FORCE EDITIONABLE VIEW "V" ("ID") AS \n  SELECT id FROM orders;\n';
    assert.equal(prepareDdl(ddl), 'CREATE OR REPLACE FORCE EDITIONABLE VIEW "V" ("ID") AS \n  SELECT id FROM orders');
  });

  it("leaves an already-clean statement alone", () => {
    assert.equal(prepareDdl("CREATE TABLE t (id NUMBER)"), "CREATE TABLE t (id NUMBER)");
  });
});

describe("copyStatements", () => {
  it("turns one DBMS_METADATA answer into runnable statements", () => {
    const ddl = [
      '  CREATE TABLE "ORDERS"',
      '   (    "ID" NUMBER,',
      '        "CUSTOMER" VARCHAR2(80),',
      '         PRIMARY KEY ("ID") ENABLE',
      "   ) ;",
      "",
    ].join("\n");
    const stmts = copyStatements(ddl);
    assert.equal(stmts.length, 1);
    assert.ok(stmts[0].startsWith('CREATE TABLE "ORDERS"'));
    assert.ok(!stmts[0].endsWith(";"), "the driver takes one statement with no terminator");
  });

  it("drops the terminator of a table but not of a trigger", () => {
    assert.deepEqual(copyStatements("CREATE TABLE t (id NUMBER);\n"), ["CREATE TABLE t (id NUMBER)"]);
    assert.deepEqual(
      copyStatements("CREATE OR REPLACE TRIGGER bi BEFORE INSERT ON t BEGIN NULL; END;\n/\n"),
      ["CREATE OR REPLACE TRIGGER bi BEFORE INSERT ON t BEGIN NULL; END;"]
    );
  });

  it("splits the trigger DDL Oracle emits into the create and the enable", () => {
    // GET_DDL answers for a trigger with two statements: the trigger itself, terminated by
    // the SQL*Plus slash because it is PL/SQL, and an ALTER carrying the enabled or disabled
    // state the source has it in. Both have to run, and they cannot run together.
    const ddl = [
      '  CREATE OR REPLACE EDITIONABLE TRIGGER "ORDERS_BI" ',
      'BEFORE INSERT ON "ORDERS"',
      "FOR EACH ROW",
      "BEGIN",
      "  IF :new.id IS NULL THEN",
      "    :new.id := ORDER_SEQ.NEXTVAL;",
      "  END IF;",
      "END;",
      "/",
      'ALTER TRIGGER "ORDERS_BI" ENABLE;',
      "",
    ].join("\n");
    const stmts = copyStatements(ddl);
    assert.equal(stmts.length, 2);
    // the block keeps its own END; — stripping it is PLS-00103 on end-of-file
    assert.ok(stmts[0].startsWith('CREATE OR REPLACE EDITIONABLE TRIGGER "ORDERS_BI"'), stmts[0]);
    assert.ok(stmts[0].endsWith("END;"), stmts[0]);
    // the ALTER is plain SQL, so its semicolon is a terminator and the driver must not see it
    assert.equal(stmts[1], 'ALTER TRIGGER "ORDERS_BI" ENABLE');
  });

  it("keeps a disabled trigger disabled, because that is what the source says", () => {
    // the state is carried by the second statement rather than by anything this app decides,
    // so a trigger somebody turned off in the source does not start firing in the target
    const stmts = copyStatements('CREATE OR REPLACE TRIGGER "T" BEFORE INSERT ON "X" BEGIN NULL; END;\n/\nALTER TRIGGER "T" DISABLE;\n');
    assert.equal(stmts[1], 'ALTER TRIGGER "T" DISABLE');
  });
});

describe("retargetSchema", () => {
  it("rewrites a quoted schema qualifier", () => {
    assert.equal(
      retargetSchema('ALTER TABLE "ORDERS" ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES "HR"."CUSTOMERS" (id)', "HR", "HR_TEST"),
      'ALTER TABLE "ORDERS" ADD CONSTRAINT fk FOREIGN KEY (c) REFERENCES "HR_TEST"."CUSTOMERS" (id)'
    );
  });

  it("rewrites a bare qualifier a developer wrote by hand", () => {
    assert.equal(
      retargetSchema('CREATE TABLE "T" ("ID" NUMBER DEFAULT HR.ORDER_SEQ.NEXTVAL)', "HR", "STAGE"),
      'CREATE TABLE "T" ("ID" NUMBER DEFAULT STAGE.ORDER_SEQ.NEXTVAL)'
    );
    assert.equal(retargetSchema("SELECT hr.t.c FROM hr.t", "HR", "STAGE"), "SELECT STAGE.t.c FROM STAGE.t");
  });

  it("quotes the target, matching what DBMS_METADATA emits", () => {
    assert.equal(retargetSchema('SELECT * FROM "HR"."T"', "HR", "STAGE"), 'SELECT * FROM "STAGE"."T"');
  });

  it("leaves a schema name inside a string literal alone", () => {
    const sql = "CREATE TABLE t (note VARCHAR2(80) DEFAULT 'contact HR.PAYROLL first')";
    assert.equal(retargetSchema(sql, "HR", "STAGE"), sql);
  });

  it("survives a doubled quote inside a literal without losing its place", () => {
    const sql = "BEGIN msg := 'it''s HR.T'; x := HR.T.c; END;";
    assert.equal(retargetSchema(sql, "HR", "STAGE"), "BEGIN msg := 'it''s HR.T'; x := STAGE.T.c; END;");
  });

  it("leaves a schema name inside a comment alone", () => {
    assert.equal(retargetSchema("-- was HR.OLD\nSELECT * FROM HR.T", "HR", "STAGE"), "-- was HR.OLD\nSELECT * FROM STAGE.T");
    assert.equal(retargetSchema("/* HR.OLD */ SELECT * FROM HR.T", "HR", "STAGE"), "/* HR.OLD */ SELECT * FROM STAGE.T");
  });

  it("does not rewrite a name that merely ends in the schema name", () => {
    assert.equal(retargetSchema("SELECT * FROM OLD_HR.T", "HR", "STAGE"), "SELECT * FROM OLD_HR.T");
    assert.equal(retargetSchema("SELECT * FROM HR_ARCHIVE.T", "HR", "STAGE"), "SELECT * FROM HR_ARCHIVE.T");
  });

  it("does not rewrite a column reference that is not a schema", () => {
    // t.HR is a column of t, and the qualifier before the dot is `t`, not `HR`
    assert.equal(retargetSchema("SELECT t.HR FROM t", "HR", "STAGE"), "SELECT t.HR FROM t");
    // a bare HR with no dot after it is a column, an alias or a word
    assert.equal(retargetSchema("SELECT HR FROM t WHERE HR > 1", "HR", "STAGE"), "SELECT HR FROM t WHERE HR > 1");
  });

  it("is a no-op when the two schemas have the same name", () => {
    const sql = 'SELECT * FROM "HR"."T"';
    assert.equal(retargetSchema(sql, "HR", "hr"), sql);
    assert.equal(retargetSchema(sql, "", "STAGE"), sql);
  });

  it("matches a bare qualifier in any case, because a developer wrote it", () => {
    assert.equal(retargetSchema("SELECT * FROM Hr.T", "HR", "STAGE"), "SELECT * FROM STAGE.T");
  });

  it("matches a quoted qualifier only exactly, because the quotes made it case-sensitive", () => {
    assert.equal(retargetSchema('SELECT * FROM "hr"."T"', "HR", "STAGE"), 'SELECT * FROM "hr"."T"');
  });

  it("repoints the tables inside a view, which is where a qualifier is likeliest to be", () => {
    // the failure this exists to stop: the view is created in the target, it is VALID, and
    // every query against it reads the source database
    const ddl = [
      'CREATE OR REPLACE FORCE EDITIONABLE VIEW "ORDER_SUMMARY_V" ("ID", "CUSTOMER") AS',
      '  SELECT o.id, c.name FROM "HR"."ORDERS" o',
      "  JOIN HR.CUSTOMERS c ON c.id = o.customer_id",
      "  WHERE o.note <> 'sent to HR.OLD_QUEUE'",
      "  -- was HR.ORDERS_OLD until the rename",
    ].join("\n");
    const out = retargetSchema(ddl, "HR", "STAGE");
    assert.ok(out.includes('"STAGE"."ORDERS"'), out);
    assert.ok(out.includes("STAGE.CUSTOMERS"), out);
    // the two that are not identifiers stay exactly as the source wrote them
    assert.ok(out.includes("'sent to HR.OLD_QUEUE'"), out);
    assert.ok(out.includes("-- was HR.ORDERS_OLD until the rename"), out);
  });

  it("repoints what a trigger body calls, and leaves its messages alone", () => {
    // a trigger is the other place a hand-written qualifier hides, and the consequence is
    // worse than a view's: an un-repointed one has the target's inserts calling the source's
    // sequence and raising the source's errors
    const ddl = [
      'CREATE OR REPLACE EDITIONABLE TRIGGER "ORDERS_BI"',
      'BEFORE INSERT ON "ORDERS"',
      "FOR EACH ROW",
      "BEGIN",
      "  :new.id := HR.ORDER_SEQ.NEXTVAL;",
      '  HR.AUDIT_PKG.note(:new.id, \'raised in HR.ORDERS\');',
      "END;",
    ].join("\n");
    const out = retargetSchema(ddl, "HR", "STAGE");
    assert.ok(out.includes("STAGE.ORDER_SEQ.NEXTVAL"), out);
    assert.ok(out.includes("STAGE.AUDIT_PKG.note"), out);
    assert.ok(out.includes("'raised in HR.ORDERS'"), out);
  });
});

describe("copyIdent", () => {
  it("quotes an ordinary name", () => {
    assert.equal(copyIdent("EMPLOYEES"), '"EMPLOYEES"');
    assert.equal(copyIdent(" mixed_Case "), '"mixed_Case"');
  });

  it("doubles a quote inside a name rather than letting it end the quoting", () => {
    // Oracle spells a literal double quote inside a quoted identifier as two of them, so this
    // still names one object — it does not become a statement boundary.
    assert.equal(copyIdent('T" ; DROP TABLE X --'), '"T"" ; DROP TABLE X --"');
  });

  it("refuses an empty or over-long name, which no object can have", () => {
    assert.equal(copyIdent("  "), null);
    assert.equal(copyIdent("A".repeat(129)), null);
  });
});

describe("dropStatement", () => {
  it("clears a table's dependants and the recycle bin in one statement", () => {
    // CASCADE CONSTRAINTS is what lets a parent table be replaced at all; PURGE is what stops
    // every replacement leaving the old table in the recycle bin.
    assert.equal(dropStatement("tables", "ORDERS"), 'DROP TABLE "ORDERS" CASCADE CONSTRAINTS PURGE');
  });

  it("keeps a quote inside a name inside the identifier", () => {
    assert.equal(dropStatement("tables", 'X"Y'), 'DROP TABLE "X""Y" CASCADE CONSTRAINTS PURGE');
  });

  it("drops an index by name alone", () => {
    // nothing depends on an index and nothing goes to the recycle bin with it, so neither
    // CASCADE CONSTRAINTS nor PURGE is a clause DROP INDEX even accepts
    assert.equal(dropStatement("indexes", "EMP_NAME_IX"), 'DROP INDEX "EMP_NAME_IX"');
  });

  it("drops a sequence by name alone", () => {
    // it always succeeds, and leaves whatever called it invalid until the new one is there —
    // which is what the kind's replace note is for, not something to guard here
    assert.equal(dropStatement("sequences", "ORDER_SEQ"), 'DROP SEQUENCE "ORDER_SEQ"');
  });

  it("spells the drop for a view it will not use", () => {
    // views are replaced in place, so nothing asks for this — but a `DROP` is spelled in one
    // place only, and a null here would mean "the name is unusable" to everyone who reads it
    assert.equal(dropStatement("views", "ORDER_SUMMARY_V"), 'DROP VIEW "ORDER_SUMMARY_V"');
  });

  it("drops a materialized view by the name the dictionary uses, not DBMS_METADATA's", () => {
    // DROP MATERIALIZED_VIEW is a syntax error; the underscore belongs to GET_DDL alone
    assert.equal(dropStatement("mviews", "SALES_MV"), 'DROP MATERIALIZED VIEW "SALES_MV"');
  });

  it("spells the drop for a trigger it will not use either", () => {
    // replaced in place like a view, for the stronger reason: a dropped trigger is a table
    // running unguarded until the create lands
    assert.equal(dropStatement("triggers", "ORDERS_BI"), 'DROP TRIGGER "ORDERS_BI"');
  });

  it("refuses a name no object could have", () => {
    assert.equal(dropStatement("tables", "   "), null);
    assert.equal(dropStatement("tables", "A".repeat(129)), null);
    assert.equal(dropStatement("indexes", ""), null);
  });

  it("has a statement for every kind, since replace is offered for all of them", () => {
    for (const kind of ALL_COPY_KINDS) {
      assert.match(String(dropStatement(kind, "SOMETHING")), /^DROP [A-Z ]+ "SOMETHING"/);
    }
  });
});

describe("copyCountLabel", () => {
  it("names the count with the kind's own plural label", () => {
    assert.equal(copyCountLabel("tables", 12), "12 Tables");
    assert.equal(copyCountLabel("tables", 1), "1 Tables");
  });

  it("groups a count large enough to be hard to read", () => {
    assert.equal(copyCountLabel("tables", 1200), "1,200 Tables");
  });

  it("names every kind, since the dialog is written from whichever one was picked", () => {
    assert.equal(copyCountLabel("indexes", 40), "40 Indexes");
    assert.equal(copyCountLabel("sequences", 3), "3 Sequences");
    assert.equal(copyCountLabel("views", 7), "7 Views");
    assert.equal(copyCountLabel("mviews", 2), "2 Materialized Views");
    assert.equal(copyCountLabel("triggers", 9), "9 Triggers");
  });
});

describe("copyBaseKinds", () => {
  it("is empty for a kind that stands on its own, so nothing is looked up for it", () => {
    // the run reads the target for these kinds and skips the base-object query entirely
    for (const kind of ["sequences", "tables", "views", "mviews"] as const) {
      assert.deepEqual(copyBaseKinds(kind), []);
    }
  });

  it("is the table alone for an index", () => {
    assert.deepEqual(copyBaseKinds("indexes"), ["tables"]);
  });

  it("is the table or the view for a trigger", () => {
    // the whole reason this is a list: an INSTEAD OF trigger's base object is a view, and
    // searching the target's tables for it would call a view that is there a missing table
    assert.deepEqual(copyBaseKinds("triggers"), ["tables", "views"]);
  });

  it("names only kinds the copy actually knows how to list", () => {
    // a base kind is put straight into the target's existence query, so one that is not a
    // real kind would be a type this app never asks Oracle about
    for (const kind of ALL_COPY_KINDS) {
      for (const base of copyBaseKinds(kind)) assert.ok(ALL_COPY_KINDS.includes(base), `${kind} → ${base}`);
    }
  });
});

describe("copyBaseLabel", () => {
  it("names the run to do first, the way the type list names it", () => {
    // it lands in "copy the tables first, then run this again" and in the confirmation
    // dialog, so it has to read as the name of a run rather than as a type of object
    assert.equal(copyBaseLabel("indexes"), "tables");
    assert.equal(copyBaseLabel("triggers"), "tables and views");
  });

  it("is empty for a kind that is built on nothing", () => {
    assert.equal(copyBaseLabel("views"), "");
    assert.equal(copyBaseLabel("sequences"), "");
  });
});
