import type { OracleSession } from "./api";
import { sessionClient } from "./sessionClient";

export const sessionGridColumns = [
  { key: "instance", label: "Instance", value: (row: OracleSession) => row.instance },
  { key: "sid", label: "SID", value: (row: OracleSession) => row.sid },
  { key: "serial", label: "Serial", value: (row: OracleSession) => row.serial },
  { key: "username", label: "User", value: (row: OracleSession) => row.username },
  { key: "status", label: "Status", value: (row: OracleSession) => row.status },
  { key: "client", label: "Client", value: (row: OracleSession) => sessionClient(row) },
  { key: "machine", label: "Machine", value: (row: OracleSession) => row.machine },
  { key: "program", label: "Program", value: (row: OracleSession) => row.program },
  { key: "ageSeconds", label: "Age (s)", value: (row: OracleSession) => row.ageSeconds },
  { key: "activeSeconds", label: "Active call (s)", value: (row: OracleSession) => row.activeSeconds },
  { key: "cpuPercent", label: "CPU (% of one core)", value: (row: OracleSession) => row.cpuPercent },
  { key: "cpuSeconds", label: "CPU total (s)", value: (row: OracleSession) => row.cpuSeconds },
  { key: "pgaMb", label: "PGA (MiB)", value: (row: OracleSession) => row.pgaMb },
  { key: "readMbps", label: "Read (MiB/s)", value: (row: OracleSession) => row.readMbps },
  { key: "writeMbps", label: "Write (MiB/s)", value: (row: OracleSession) => row.writeMbps },
  { key: "readMb", label: "Read total (MiB)", value: (row: OracleSession) => row.readMb },
  { key: "writeMb", label: "Write total (MiB)", value: (row: OracleSession) => row.writeMb },
  { key: "sqlId", label: "SQL ID", value: (row: OracleSession) => row.sqlId },
  { key: "event", label: "Wait event", value: (row: OracleSession) => row.event },
] as const;

export type SessionGridColumnKey = typeof sessionGridColumns[number]["key"];
export type SessionColumnFilters = Partial<Record<SessionGridColumnKey, string>>;

export function matchesSessionColumnFilters(row: OracleSession, filters: SessionColumnFilters): boolean {
  return sessionGridColumns.every(column => {
    const query = filters[column.key]?.trim().toLocaleLowerCase();
    if (!query) return true;
    const value = column.value(row);
    if (value == null) return false;
    const text = String(value).toLocaleLowerCase();
    return column.key === "status" || column.key === "instance" || column.key === "sid" || column.key === "serial"
      ? text === query
      : text.includes(query);
  });
}


export const sessionThresholds = [
  { key: "ageSeconds", label: "Session age ≥ seconds" },
  { key: "activeSeconds", label: "Active call ≥ seconds" },
  { key: "cpuPercent", label: "CPU ≥ % of one core" },
  { key: "cpuSeconds", label: "CPU total ≥ seconds" },
  { key: "pgaMb", label: "PGA ≥ MiB" },
  { key: "readMbps", label: "Disk read ≥ MiB/s" },
  { key: "writeMbps", label: "Disk write ≥ MiB/s" },
  { key: "readMb", label: "Total reads ≥ MiB" },
  { key: "writeMb", label: "Total writes ≥ MiB" },
] as const;
export type SessionThresholds = Partial<Record<typeof sessionThresholds[number]["key"], string>>;
export function matchesSessionThresholds(row: OracleSession, thresholds: SessionThresholds): boolean {
  return sessionThresholds.every(({key}) => {
    const raw = thresholds[key]?.trim();
    if (!raw) return true;
    const value = row[key];
    const minimum = Number(raw);
    return Number.isFinite(minimum) && minimum >= 0 && value != null && value >= minimum;
  });
}

export function sampleSessionRates(current: OracleSession[], previous: OracleSession[], seconds: number): OracleSession[] {
  const identity = (row: OracleSession) => `${row.instance}:${row.sid}:${row.serial}:${row.logonTime}`;
  const before = new Map(previous.map(row => [identity(row), row]));
  return current.map(row => {
    const prior = before.get(identity(row));
    const rate = (key: "cpuSeconds" | "readMb" | "writeMb", multiplier = 1) => {
      const now = row[key], old = prior?.[key];
      return seconds > 0 && now != null && old != null && now >= old
        ? Math.round((now-old)/seconds*multiplier*100)/100 : null;
    };
    return {...row, cpuPercent: rate("cpuSeconds", 100), readMbps: rate("readMb"), writeMbps: rate("writeMb")};
  });
}

export function formatSessionValue(value: unknown): string {
  return typeof value === "number" ? value.toLocaleString(undefined, {maximumFractionDigits: 2}) : String(value ?? "—");
}
