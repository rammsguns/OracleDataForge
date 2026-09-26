/** Oracle sessions report client software inconsistently in PROGRAM and MODULE.
 * Recognize common tools without hiding the original values in the details pane. */
export function sessionClient(row: { program?: string | null; module?: string | null; clientInfo?: string | null; clientDriver?: string | null }): string {
  const values = [row.module, row.program, row.clientInfo].filter((value): value is string => !!value?.trim());
  const names: [RegExp, string][] = [
    [/\btoad(?:\.exe|\s+for\s+oracle)?\b/i, "Toad"],
    [/\bpl\s*\/\s*sql\s+developer\b/i, "PL/SQL Developer"],
    [/\b(?:sql\s*developer|sqldeveloper|sqldev)\b/i, "SQL Developer"],
    [/\bdbeaver\b/i, "DBeaver"],
    [/\bdatagrip\b/i, "DataGrip"],
    [/\bsqlcl\b/i, "SQLcl"],
    [/\bsql\s*\*?\s*plus(?:\.exe)?\b/i, "SQL*Plus"],
    [/\boracle\s*dataforge\b/i, "OracleDataForge"],
  ];
  for (const value of values) {
    for (const [pattern, name] of names) if (pattern.test(value)) return name;
  }
  const driver = row.clientDriver?.trim();
  if (driver && /\bnode-oracledb\b/i.test(driver)) return "node-oracledb";
  if (driver && /\bjdbc\b/i.test(driver)) return "JDBC client";
  return row.program?.trim() || row.module?.trim() || driver || "Not reported";
}
