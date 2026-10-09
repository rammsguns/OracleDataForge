/** Resource metrics describe the connected Oracle instance, never the app host. */
type Row = Record<string, string | number | null>;
export type ResourceMetric = { label: string; value: string; detail: string };
export type ResourceGroup = { title: string; description: string; metrics: ResourceMetric[] };
export type ResourceReport = {
  sampledAt: string;
  groups: ResourceGroup[];
  waits: { event: string; waitClass: string; waits: number; totalSeconds: number; averageMs: number }[];
};
type Query = (sql: string) => Promise<Row[]>;
const numeric = (value: unknown): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const lookup = (rows: Row[], name: string) => numeric(rows.find(r => r.n === name)?.v);
const format = (v: number | null, unit = '', divisor = 1) => v === null ? 'Unavailable' : `${(v / divisor).toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit ? ` ${unit}` : ''}`;
const ratio = (a: number | null, b: number | null) => a !== null && b !== null && b > 0 ? a / b : null;

export async function readPerformanceResources(q: Query): Promise<ResourceReport> {
  const os = await q(`SELECT stat_name AS "n", value AS "v" FROM v$osstat`);
  const instance = (await q(`SELECT host_name AS "host", instance_name AS "instance", TO_CHAR(startup_time,'YYYY-MM-DD HH24:MI:SS') AS "startup" FROM v$instance`))[0];
  const hostMetrics = await q(`SELECT metric_name AS "n", value AS "v", intsize_csec AS "interval" FROM v$sysmetric ORDER BY intsize_csec DESC, end_time DESC`);
  const containerMetrics = await q(`SELECT metric_name AS "n", value AS "v", intsize_csec AS "interval" FROM v$con_sysmetric ORDER BY intsize_csec DESC, end_time DESC`);
  const pga = await q(`SELECT name AS "n", value AS "v" FROM v$pgastat`);
  const sga = await q(`SELECT name AS "n", bytes AS "v" FROM v$sgainfo`);
  const io = (await q(`SELECT SUM(small_read_reqs + large_read_reqs) AS "reads", SUM(small_write_reqs + large_write_reqs) AS "writes",
    SUM(small_read_servicetime + large_read_servicetime) AS "readMs", SUM(small_write_servicetime + large_write_servicetime) AS "writeMs"
    FROM v$iostat_file`))[0];
  const waits = await q(`SELECT event AS "event", wait_class AS "waitClass", total_waits AS "waits", time_waited_micro/1e6 AS "totalSeconds",
    time_waited_micro/NULLIF(total_waits,0)/1000 AS "averageMs" FROM v$system_event
    WHERE wait_class <> 'Idle' AND total_waits > 0 ORDER BY time_waited_micro DESC FETCH FIRST 10 ROWS ONLY`);
  const o = (name: string) => lookup(os, name);
  const mi = (label: string, name: string, unit: string, divisor = 1): ResourceMetric => {
    const row = containerMetrics.find(r => r.n === name) ?? hostMetrics.find(r => r.n === name);
    const seconds = numeric(row?.interval);
    return { label, value: format(numeric(row?.v), unit, divisor), detail: row ? `${containerMetrics.includes(row) ? 'Container' : 'Instance'} · ${seconds === null ? 'latest' : format(seconds / 100, 's')} metric interval` : 'Not exposed by this connection' };
  };
  const item = (label: string, value: number | null, unit: string, detail: string, divisor = 1): ResourceMetric => ({ label, value: format(value, unit, divisor), detail });
  const GB = 1024 ** 3;
  const physical = o('PHYSICAL_MEMORY_BYTES'), free = o('FREE_MEMORY_BYTES');
  const busy = o('BUSY_TIME'), idle = o('IDLE_TIME');
  const total = busy !== null && idle !== null ? busy + idle : null;
  const cpuPart = (name: string) => { const r = ratio(o(name), total); return r === null ? null : r * 100; };
  return {
    sampledAt: new Date().toISOString(),
    groups: [
      { title: 'CPU & host', description: `${instance?.host ?? 'Host unavailable'} · ${instance?.instance ?? 'Instance unavailable'} · started ${instance?.startup ?? 'unavailable'}`, metrics: [
        item('Host CPU utilization', lookup(hostMetrics, 'Host CPU Utilization (%)'), '%', 'Latest instance metric interval'),
        item('Logical CPUs', o('NUM_CPUS'), '', 'Processors available to Oracle'),
        item('CPU cores', o('NUM_CPU_CORES'), '', 'Reported by the database operating system'),
        item('CPU sockets', o('NUM_CPU_SOCKETS'), '', 'Reported by the database operating system'),
        item('Host load', o('LOAD'), '', 'Runnable processes; platform dependent'),
        mi('Database CPU', 'CPU Usage Per Sec', 'CPU seconds/s', 100),
        item('User CPU share', cpuPart('USER_TIME'), '%', 'Cumulative share of busy + idle CPU time'),
        item('Kernel CPU share', cpuPart('SYS_TIME'), '%', 'Cumulative share of busy + idle CPU time'),
        item('I/O wait CPU share', cpuPart('IOWAIT_TIME'), '%', 'Cumulative share; platform dependent'),
        item('Idle CPU share', cpuPart('IDLE_TIME'), '%', 'Cumulative share of busy + idle CPU time'),
      ] },
      { title: 'RAM & Oracle memory', description: 'Host memory and instance allocations. SGA and PGA do not represent total host RAM use.', metrics: [
        item('Physical RAM', physical, 'GiB', 'Total memory reported by Oracle', GB),
        item('Free host RAM', free, 'GiB', 'Available only on supported platforms', GB),
        item('Non-free host RAM', physical !== null && free !== null && free <= physical ? physical - free : null, 'GiB', 'Physical minus free; includes OS caches', GB),
        item('SGA allocated', lookup(sga, 'Maximum SGA Size'), 'GiB', 'Shared global area allocation', GB),
        item('Buffer cache', lookup(sga, 'Buffer Cache Size'), 'GiB', 'SGA database block cache', GB),
        item('Shared pool', lookup(sga, 'Shared Pool Size'), 'GiB', 'SGA SQL and dictionary cache', GB),
        item('PGA allocated', lookup(pga, 'total PGA allocated'), 'GiB', 'Current process memory allocation', GB),
        item('PGA in use', lookup(pga, 'total PGA inuse'), 'GiB', 'Current process memory in use', GB),
        item('Peak PGA allocated', lookup(pga, 'maximum PGA allocated'), 'GiB', 'Peak since instance startup', GB),
        item('PGA target', lookup(pga, 'aggregate PGA target parameter'), 'GiB', 'Configured aggregate target', GB),
        item('PGA cache hit', lookup(pga, 'cache hit percentage'), '%', 'Cumulative since instance startup'),
        item('PGA overallocations', lookup(pga, 'over allocation count'), '', 'Cumulative since instance startup'),
      ] },
      { title: 'Disk & database I/O', description: 'Database file activity. Filesystem capacity and physical disk utilization require host monitoring.', metrics: [
        mi('Read throughput', 'Physical Read Total Bytes Per Sec', 'MiB/s', 1024 ** 2),
        mi('Write throughput', 'Physical Write Total Bytes Per Sec', 'MiB/s', 1024 ** 2),
        mi('Read requests', 'Physical Read Total IO Requests Per Sec', 'IOPS'),
        mi('Write requests', 'Physical Write Total IO Requests Per Sec', 'IOPS'),
        mi('Redo generated', 'Redo Generated Per Sec', 'MiB/s', 1024 ** 2),
        item('Average file read latency', ratio(numeric(io?.readMs), numeric(io?.reads)), 'ms', 'All database files; cumulative service time / requests'),
        item('Average file write latency', ratio(numeric(io?.writeMs), numeric(io?.writes)), 'ms', 'All database files; cumulative service time / requests'),
        item('File read requests', numeric(io?.reads), '', 'Cumulative database file reads'),
        item('File write requests', numeric(io?.writes), '', 'Cumulative database file writes'),
      ] },
      { title: 'Workload & efficiency', description: 'Latest Oracle metric interval; container metrics preferred when available.', metrics: [
        mi('Average active sessions', 'Average Active Sessions', 'sessions'),
        mi('Executions', 'Executions Per Sec', '/s'),
        mi('Transactions', 'User Transaction Per Sec', '/s'),
        mi('User calls', 'User Calls Per Sec', '/s'),
        mi('Logical reads', 'Logical Reads Per Sec', 'blocks/s'),
        mi('Hard parses', 'Hard Parse Count Per Sec', '/s'),
        mi('Buffer cache hit', 'Buffer Cache Hit Ratio', '%'),
        mi('Library cache hit', 'Library Cache Hit Ratio', '%'),
        mi('Database wait ratio', 'Database Wait Time Ratio', '%'),
      ] },
    ],
    waits: waits.map(r => ({ event: String(r.event), waitClass: String(r.waitClass), waits: numeric(r.waits) ?? 0, totalSeconds: numeric(r.totalSeconds) ?? 0, averageMs: numeric(r.averageMs) ?? 0 })),
  };
}
