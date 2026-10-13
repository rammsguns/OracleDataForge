import assert from 'node:assert/strict';
import test from 'node:test';
import { missingPackageHeaders, syncPackageSpec } from './packageSync';
test('finds missing overloads and preserves existing spec declarations', () => {
  const spec = 'CREATE OR REPLACE PACKAGE demo AS\n PROCEDURE p(x NUMBER DEFAULT 1);\nEND demo;';
  const body = `CREATE OR REPLACE PACKAGE BODY demo AS
 PROCEDURE p(x NUMBER) IS BEGIN NULL; END;
 PROCEDURE p(x VARCHAR2) IS BEGIN NULL; END;
 FUNCTION f RETURN NUMBER AS BEGIN RETURN 1; END f;
 END demo;`;
  const missing = missingPackageHeaders(spec, body);
  assert.deepEqual(missing.map(h => h.declaration), ['PROCEDURE p(x VARCHAR2);', 'FUNCTION f RETURN NUMBER;']);
  const synced = syncPackageSpec(spec, missing);
  assert.ok(synced.includes('PROCEDURE p(x NUMBER DEFAULT 1);'));
  assert.ok(synced.endsWith('END demo;'));
  assert.deepEqual(missingPackageHeaders(synced, body), []);
});
test('skips local routines, initialization, comments and literal keywords', () => {
  const spec = 'PACKAGE demo IS END;';
  const body = `PACKAGE BODY demo IS
 -- PROCEDURE fake IS
 PROCEDURE public_p IS
   PROCEDURE local_p IS BEGIN NULL; END;
   FUNCTION local_f RETURN NUMBER IS BEGIN RETURN 0; END;
 BEGIN
   IF 1 = 1 THEN
     FOR i IN 1..2 LOOP NULL; END LOOP;
   END IF;
   BEGIN NULL; END;
   DBMS_OUTPUT.PUT_LINE(q'[END; PROCEDURE fake IS]');
 END public_p;
 FUNCTION public_f RETURN VARCHAR2 IS BEGIN RETURN 'AS END;'; END;
 BEGIN NULL; END;`;
  assert.deepEqual(missingPackageHeaders(spec, body).map(h => h.name), ['PUBLIC_P', 'PUBLIC_F']);
});
test('handles quoted identifiers, forward declarations and parameter defaults', () => {
  const spec = 'PACKAGE demo AS PROCEDURE "p"(x VARCHAR2 DEFAULT q\'[a,b]\'); END;';
  const body = `PACKAGE BODY demo AS
 PROCEDURE "p"(x VARCHAR2) IS BEGIN NULL; END;
 PROCEDURE other;
 PROCEDURE other IS BEGIN NULL; END;
 END;`;
  assert.deepEqual(missingPackageHeaders(spec, body).map(h => h.declaration), ['PROCEDURE other;']);
});
test('does not duplicate headers when IN is implicit or parentheses are omitted', () => {
  const spec = 'PACKAGE demo AS PROCEDURE p(x IN NUMBER DEFAULT 1); PROCEDURE no_args(); END;';
  const body = 'PACKAGE BODY demo AS PROCEDURE p(x NUMBER) IS BEGIN NULL; END; PROCEDURE no_args IS BEGIN NULL; END; END;';
  assert.deepEqual(missingPackageHeaders(spec, body), []);
});
test('trailing header comments do not swallow the generated semicolon', () => {
  const spec = 'PACKAGE demo AS END;';
  const body = 'PACKAGE BODY demo AS PROCEDURE p -- implementation\n IS BEGIN NULL; END; END;';
  assert.equal(missingPackageHeaders(spec, body)[0].declaration, 'PROCEDURE p;');
});
