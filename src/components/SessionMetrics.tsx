import { Activity, Cpu, Database, HardDrive } from "lucide-react";
import type { OracleSession } from "../utils/api";
import { formatSessionValue } from "../utils/sessionGrid";

type Metric = { field: keyof OracleSession; label: string; unit?: string; detail: string; rate?: boolean };
const groups: { title: string; icon: typeof Cpu; metrics: Metric[] }[] = [
  { title: "CPU & duration", icon: Cpu, metrics: [
    { field: "cpuPercent", label: "CPU usage", unit: "%", detail: "Percent of one CPU core between refreshes", rate: true },
    { field: "cpuSeconds", label: "CPU time", unit: "s", detail: "Cumulative since session start" },
    { field: "ageSeconds", label: "Session age", unit: "s", detail: "Time since logon" },
    { field: "activeSeconds", label: "Active call duration", unit: "s", detail: "Time in the active state, including waits" },
  ]},
  { title: "RAM & Oracle memory", icon: Database, metrics: [
    { field: "pgaMb", label: "Current PGA", unit: "MiB", detail: "Private Oracle memory allocated to this session" },
    { field: "pgaPeakMb", label: "Peak PGA", unit: "MiB", detail: "Highest allocation since session start" },
    { field: "ugaMb", label: "Current UGA", unit: "MiB", detail: "Session memory; may overlap PGA" },
  ]},
  { title: "Disk & database I/O", icon: HardDrive, metrics: [
    { field: "readMbps", label: "Read throughput", unit: "MiB/s", detail: "Average between refreshes", rate: true },
    { field: "writeMbps", label: "Write throughput", unit: "MiB/s", detail: "Average between refreshes", rate: true },
    { field: "readMb", label: "Total data read", unit: "MiB", detail: "Cumulative since session start" },
    { field: "writeMb", label: "Total data written", unit: "MiB", detail: "Cumulative since session start" },
    { field: "readRequests", label: "Read requests", detail: "Cumulative physical I/O requests" },
    { field: "writeRequests", label: "Write requests", detail: "Cumulative physical I/O requests" },
  ]},
  { title: "Workload & efficiency", icon: Activity, metrics: [
    { field: "executions", label: "Executions", detail: "Cumulative SQL execution count" },
    { field: "hardParses", label: "Hard parses", detail: "Cumulative since session start" },
    { field: "logicalReads", label: "Logical reads", unit: "blocks", detail: "Reads from Oracle buffers and private memory" },
    { field: "redoMb", label: "Redo generated", unit: "MiB", detail: "Cumulative since session start" },
  ]},
];

export default function SessionMetrics({ session, capturedAt, available }: {
  session: OracleSession; capturedAt: string; available?: boolean;
}) {
  return <div className="p-4 space-y-4">
    <div className="flex flex-wrap items-center gap-2 text-mute text-[11px]">
      <Activity size={13} />
      <span>Instance {session.instance} · SID {session.sid},{session.serial} · sampled {new Date(capturedAt).toLocaleTimeString()}</span>
    </div>
    {available === false && <p className="rounded-lg border border-warn/25 bg-warn/8 p-3 text-soft">Resource statistics are unavailable with this connection’s view permissions.</p>}
    <div className="grid grid-cols-2 gap-3">
      {[
        {label: "CPU", field: "cpuPercent", unit: "% of one core"},
        {label: "RAM · PGA", field: "pgaMb", unit: "MiB"},
        {label: "Disk reads", field: "readMbps", unit: "MiB/s"},
        {label: "Disk writes", field: "writeMbps", unit: "MiB/s"},
      ].map(tile => {
        const value = session[tile.field as keyof OracleSession];
        return <div key={tile.field} className="bg-panel border border-bdr rounded-xl p-3">
          <div className="text-mute text-[11px]">{tile.label}</div>
          <div className="text-[22px] font-semibold tabular-nums mt-1">{value == null ? "—" : formatSessionValue(value)}</div>
          <div className="text-mute text-[10px]">{tile.unit}</div>
        </div>;
      })}
    </div>
    <p className="text-[11px] text-mute">Rates need two refreshes. CPU counters may update at call completion. Memory reflects Oracle allocation rather than total process RAM.</p>
    <div className="grid xl:grid-cols-2 gap-3">
      {groups.map(group => <section key={group.title} className="bg-panel border border-bdr rounded-xl p-4">
        <h3 className="flex items-center gap-2 font-semibold text-[13px] mb-2"><group.icon size={14} className="text-accent" />{group.title}</h3>
        <dl className="grid grid-cols-2 gap-x-4">
          {group.metrics.map(metric => {
            const value = session[metric.field];
            return <div key={metric.field} className="py-2.5 border-t border-bdrsoft min-w-0">
              <dt className="text-soft text-[11px]">{metric.label}</dt>
              <dd className={`font-semibold tabular-nums ${value == null ? "text-mute text-[12px]" : "text-ink text-[18px]"}`}>
                {value == null ? metric.rate && available !== false ? "Awaiting sample" : metric.field === "activeSeconds" && session.status !== "ACTIVE" ? "Inactive" : "Unavailable" : `${formatSessionValue(value)}${metric.unit ? " " + metric.unit : ""}`}
              </dd>
              <dd className="text-mute text-[10px] mt-0.5">{metric.detail}</dd>
            </div>;
          })}
        </dl>
      </section>)}
    </div>
    <section className="bg-panel border border-bdr rounded-xl p-4">
      <h3 className="font-semibold text-[13px] mb-3">Current SQL & wait activity</h3>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2">
        {([
          ["sqlId", "SQL ID"], ["previousSqlId", "Previous SQL ID"], ["sqlExecStart", "Execution started"],
          ["event", "Wait event"], ["waitClass", "Wait class"], ["waitState", "Wait state"],
          ["blockingInstance", "Blocking instance"], ["blockingSid", "Blocking SID"],
        ] as [keyof OracleSession, string][]).map(([field, label]) => <div key={field} className="contents">
          <dt className="text-mute">{label}</dt><dd className="font-mono break-all">{formatSessionValue(session[field])}</dd>
        </div>)}
      </dl>
    </section>
  </div>;
}
