/** Parse Oracle SQL Developer's Export Connections JSON (the `connections` array format). */
export interface SqlDeveloperConnection {
  name: string;
  engine: "oracle";
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  readOnly: boolean;
  role: string;
  authMode: "basic" | "wallet";
  needsWallet?: boolean;
}

const MAX_ENTRIES = 500;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Returns null when this is not SQL Developer's JSON export format. */
export function parseSqlDeveloperExport(raw: unknown): SqlDeveloperConnection[] | null {
  const root = record(raw);
  if (!root || !Array.isArray(root.connections)) return null;
  if (root.connections.length > MAX_ENTRIES) throw new Error(`This file contains more than ${MAX_ENTRIES} connections.`);

  const parsed: SqlDeveloperConnection[] = [];
  for (const [index, item] of root.connections.entries()) {
    const entry = record(item);
    const info = record(entry?.info);
    if (!entry || !info) continue;
    const name = String(entry.name ?? info.ConnName ?? `SQL Developer connection ${index + 1}`).slice(0, 120);
    const type = String(info.OracleConnectionType ?? "BASIC").toUpperCase();
    const cloud = ["CLOUD", "CLOUD_WALLET", "CLOUD WALLET"].includes(type);
    let host = String(info.hostname ?? "").trim();
    let port = Number(info.port ?? 1521);
    let database = String(info.serviceName ?? info.service ?? "").trim();
    // ADVANCED exports often store a full Oracle Net descriptor, including SCAN
    // addresses and failover options. Preserve it instead of reducing it to one host.
    const jdbc = String(info.customUrl ?? info.url ?? "").trim();
    const target = jdbc.replace(/^jdbc:oracle:(?:thin|oci):@/i, "").trim();
    if (target.startsWith("(")) {
      const descriptorHost = target.match(/\(\s*HOST\s*=\s*([^()]+)\)/i);
      const descriptorPort = target.match(/\(\s*PORT\s*=\s*(\d+)\s*\)/i);
      if (descriptorHost && /\(\s*(?:SERVICE_NAME|SID)\s*=/i.test(target)) {
        host = descriptorHost[1].trim().replace(/^"|"$/g, "");
        port = Number(descriptorPort?.[1] ?? 1521);
        database = target;
      }
    } else if (jdbc) {
      const match = target.match(/^(?:\/\/)?(\[[^\]]+\]|[^:/?#]+)(?::(\d+))?\/([^?#]+)(\?[^#]*)?$/i);
      if (match) {
        host = match[1];
        port = Number(match[2] ?? 1521);
        database = match[3] + (match[4] ?? "");
      } else {
        const sid = target.match(/^(\[[^\]]+\]|[^:]+):(\d+):([^:()]+)$/);
        if (sid) {
          host = sid[1];
          port = Number(sid[2]);
          database = `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))(CONNECT_DATA=(SID=${sid[3]})))`;
        }
      }
    }
    if (cloud) {
      // A SQL Developer export references a local wallet; it does not carry its files.
      database = String(info.cloudService ?? info.cloudServiceName ?? info.serviceName ?? info.service ?? info.tnsAlias ?? info.tnsName ?? "").trim();
      host = "";
      port = 0;
    }
    if (!cloud && type !== "BASIC" && (!host || !database)) {
      throw new Error(`"${name}" uses SQL Developer connection type ${type}; this export does not include a direct host and service name for it.`);
    }
    if (!cloud && (!Number.isFinite(port) || port < 1 || port > 65535)) port = 1521;

    const rawRole = String(info.role ?? "").trim().toUpperCase();
    const role = ["SYSDBA", "SYSOPER", "SYSBACKUP", "SYSDG", "SYSKM", "SYSASM"].includes(rawRole) ? rawRole : "default";
    parsed.push({
      name,
      engine: "oracle",
      host,
      port,
      user: String(info.user ?? ""),
      // SQL Developer protects exported passwords with its own key format. Do not mistake
      // its encoded value for an Oracle password; users can set credentials after import.
      password: "",
      database,
      readOnly: true,
      role,
      authMode: cloud ? "wallet" : "basic",
      ...(cloud ? { needsWallet: true } : {}),
    });
  }
  return parsed;
}
