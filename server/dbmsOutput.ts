import oracledb from "oracledb";

export const DBMS_OUTPUT_MAX_LINES = 1000;
export interface DbmsOutput {
  dbmsOutput: string[];
  dbmsOutputTruncated?: boolean;
}

export async function readDbmsOutput(conn: Pick<oracledb.Connection, "execute">): Promise<{ lines: string[]; truncated: boolean }> {
  try {
    const result = await conn.execute("BEGIN DBMS_OUTPUT.GET_LINES(:lines, :n); END;", {
      lines: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxSize: 32767, maxArraySize: DBMS_OUTPUT_MAX_LINES + 1 },
      n: { dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: DBMS_OUTPUT_MAX_LINES + 1 },
    });
    const binds = result.outBinds as { lines?: (string | null)[]; n?: number };
    const count = Number(binds.n ?? 0);
    return {
      lines: (binds.lines ?? []).slice(0, Math.min(count, DBMS_OUTPUT_MAX_LINES)).map(line => line ?? ""),
      truncated: count > DBMS_OUTPUT_MAX_LINES,
    };
  } catch {
    return { lines: [], truncated: false };
  }
}

/** Enable and drain output on the execution session, including when the statement fails. */
export async function withDbmsOutput<T>(conn: Pick<oracledb.Connection, "execute">, run: () => Promise<T>): Promise<{ result: T } & DbmsOutput> {
  try {
    try { await conn.execute("BEGIN DBMS_OUTPUT.DISABLE; DBMS_OUTPUT.ENABLE(NULL); END;"); }
    catch { /* Output privileges must not prevent otherwise valid SQL from running. */ }
    let result: T;
    try {
      result = await run();
    } catch (error) {
      const output = await readDbmsOutput(conn);
      if (error && typeof error === "object") {
        Object.assign(error, { dbmsOutput: output.lines, dbmsOutputTruncated: output.truncated });
      }
      throw error;
    }
    const output = await readDbmsOutput(conn);
    return { result, dbmsOutput: output.lines, dbmsOutputTruncated: output.truncated };
  } finally {
    try { await conn.execute("BEGIN DBMS_OUTPUT.DISABLE; END;"); }
    catch { /* Session cleanup is best effort. */ }
  }
}
