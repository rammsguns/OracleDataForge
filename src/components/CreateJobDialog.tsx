import { useEffect, useState } from "react";
import { useStudio } from "../state/store";
import { api } from "../utils/api";
import { Btn, Field, Modal, inputCls } from "./ui";

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export default function CreateJobDialog({ connId, sourceJob, onClose, onCreated }: {
  connId: string; sourceJob?: string; onClose: () => void; onCreated: () => void;
}) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === connId);
  const [name, setName] = useState(sourceJob ? `${sourceJob.slice(0, 123)}_COPY` : "");
  const [loading, setLoading] = useState(!!sourceJob);
  const [loaded, setLoaded] = useState(!sourceJob);
  const [namedProgram, setNamedProgram] = useState(false);
  const [namedSchedule, setNamedSchedule] = useState(false);
  const [type, setType] = useState("PLSQL_BLOCK");
  const [action, setAction] = useState("");
  const [start, setStart] = useState("");
  const [frequency, setFrequency] = useState("once");
  const [interval, setInterval] = useState("1");
  const [customRepeat, setCustomRepeat] = useState("");
  const repeat = frequency === "once" ? "" : frequency === "custom" ? customRepeat.trim()
    : `FREQ=${frequency};INTERVAL=${Number(interval)}`;
  const validRepeat = frequency === "once" || (frequency === "custom" ? !!customRepeat.trim()
    : /^\d+$/.test(interval) && Number(interval) >= 1 && Number(interval) <= 99);
  const [comments, setComments] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [autoDrop, setAutoDrop] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!sourceJob) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const result = await api.query(connId, `SELECT job_type, job_action, TO_CHAR(SYS_EXTRACT_UTC(start_date), 'YYYY-MM-DD"T"HH24:MI:SS.FF3') AS start_utc, repeat_interval, comments, enabled, auto_drop, program_name, schedule_name FROM user_scheduler_jobs WHERE job_name = ${literal(sourceJob)}`);
        if (result.error) throw new Error(result.error.message);
        const row = result.rows?.[0];
        if (!row) throw new Error("The source job could not be found. Refresh Scheduler and try again.");
        if (cancelled) return;
        setType(String(row[0] ?? "PLSQL_BLOCK"));
        setAction(String(row[1] ?? ""));
        if (row[2]) {
          const date = new Date(`${row[2]}Z`);
          if (!Number.isFinite(date.getTime())) throw new Error("The source job start date could not be read.");
          setStart(new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 23));
        }
        const repeat = String(row[3] ?? "");
        const simple = /^FREQ=(MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY)(?:;INTERVAL=([1-9]\d?))?$/i.exec(repeat);
        setFrequency(!repeat ? "once" : simple ? simple[1].toUpperCase() : "custom");
        setInterval(simple?.[2] ?? "1");
        setCustomRepeat(repeat);
        setComments(String(row[4] ?? ""));
        setEnabled(String(row[5]).toUpperCase() === "TRUE");
        setAutoDrop(String(row[6]).toUpperCase() === "TRUE");
        setNamedProgram(!!row[7]);
        setNamedSchedule(!!row[8]);
        setLoaded(true);
      } catch (e) { if (!cancelled) setError((e as Error).message); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [connId, sourceJob]);
  const writable = !!conn?.live && conn.status === "connected" && !conn.readOnly &&
    (s.accessRole === "Administrator" || s.accessRole === "Developer");
  const validName = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(name.trim()) && (!sourceJob || name.trim().toUpperCase() !== sourceJob.toUpperCase());
  // datetime-local is interpreted in the browser's timezone, then sent with an explicit UTC offset.
  const date = start ? new Date(start) : null;
  const validDate = !date || Number.isFinite(date.getTime());
  const startSql = date && validDate
    ? `TO_TIMESTAMP_TZ(${literal(date.toISOString().replace("T", " ").replace("Z", " +00:00"))}, 'YYYY-MM-DD HH24:MI:SS.FF3 TZH:TZM')`
    : "SYSTIMESTAMP";
  const createStatement = `BEGIN\n  DBMS_SCHEDULER.CREATE_JOB(\n    job_name => ${literal(name.trim().toUpperCase())},\n    job_type => ${literal(type)},\n    job_action => ${literal(action.trim())},\n    start_date => ${startSql},\n    repeat_interval => ${repeat.trim() ? literal(repeat.trim()) : "NULL"},\n    enabled => ${enabled ? "TRUE" : "FALSE"},\n    auto_drop => ${autoDrop ? "TRUE" : "FALSE"},\n    comments => ${comments.trim() ? literal(comments.trim()) : "NULL"}\n  );\nEND;`;
  // COPY_JOB preserves arguments and advanced settings outside this form.
  const setAttribute = (attribute: string, value: string) => `  DBMS_SCHEDULER.SET_ATTRIBUTE(${literal(name.trim().toUpperCase())}, ${literal(attribute)}, ${value});`;
  const statement = sourceJob ? [
    "BEGIN",
    `  DBMS_SCHEDULER.COPY_JOB(old_job => ${literal(sourceJob)}, new_job => ${literal(name.trim().toUpperCase())});`,
    ...(!namedProgram ? [setAttribute("job_type", literal(type)), setAttribute("job_action", literal(action.trim()))] : []),
    ...(!namedSchedule ? [setAttribute("start_date", startSql), repeat.trim() ? setAttribute("repeat_interval", literal(repeat.trim())) : `  DBMS_SCHEDULER.SET_ATTRIBUTE_NULL(${literal(name.trim().toUpperCase())}, 'repeat_interval');`] : []),
    setAttribute("auto_drop", autoDrop ? "TRUE" : "FALSE"),
    comments.trim() ? setAttribute("comments", literal(comments.trim())) : `  DBMS_SCHEDULER.SET_ATTRIBUTE_NULL(${literal(name.trim().toUpperCase())}, 'comments');`,
    ...(enabled ? [`  DBMS_SCHEDULER.ENABLE(${literal(name.trim().toUpperCase())});`] : []),
    "END;",
  ].join("\n") : createStatement;
  const create = async (sql = statement, confirmed = false) => {
    if (!writable || busy || !loaded || !validName || (!namedProgram && !action.trim()) || !validDate || !validRepeat) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.query(connId, sql, confirmed);
      if (result.confirmation) {
        s.askConfirm({ title: "Create scheduler job?", body: result.confirmation.body,
          confirmLabel: "Create job", danger: false, onConfirm: () => { void create(sql, true); } });
        return;
      }
      if (result.error) throw new Error(result.error.message);
      s.toast("success", "Scheduler job created");
      onCreated();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={`${sourceJob ? `Create similar to ${sourceJob}` : "Create scheduler job"} — ${conn?.name ?? "Connection"}`} onClose={() => { if (!busy) onClose(); }} width={680}>
    <div className="space-y-3">
      {loading && <p className="text-[12px] text-mute">Loading job configuration…</p>}
      {sourceJob && loaded && <p className="text-[12px] text-mute">Configuration preloaded. Choose a new name and review the settings before creating. Arguments and advanced settings are retained.{namedProgram ? " The named program is retained." : ""}{namedSchedule ? " The named schedule is retained." : ""}</p>}
      <fieldset disabled={busy || !loaded} className="space-y-3">
        <Field label="Job name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="MY_JOB" /></Field>
        {name && !validName && <p className="text-[12px] text-err">Use an unqualified name starting with a letter, followed by letters, digits, _, $, or # (up to 128 characters).</p>}
        <Field label="Job type"><select disabled={namedProgram} className={inputCls} value={type} onChange={(e) => setType(e.target.value)}>
          {!["PLSQL_BLOCK", "STORED_PROCEDURE"].includes(type) && <option value={type}>{type || "Named program"}</option>}
          <option value="PLSQL_BLOCK">PL/SQL block</option><option value="STORED_PROCEDURE">Stored procedure (no arguments)</option>
        </select></Field>
        <Field label={type === "PLSQL_BLOCK" ? "PL/SQL block" : "Procedure name"}>
          <textarea disabled={namedProgram} className={`${inputCls.replace("h-8", "")} font-mono py-2 resize-y`} style={{ minHeight: type === "PLSQL_BLOCK" ? 240 : 80 }} rows={type === "PLSQL_BLOCK" ? 12 : 4} value={action} onChange={(e) => setAction(e.target.value)} placeholder={type === "PLSQL_BLOCK" ? "BEGIN\n  MY_PACKAGE.MY_PROCEDURE;\nEND;" : "MY_PACKAGE.MY_PROCEDURE"} />
        </Field>
        <Field label="Start date (your local timezone; blank = when enabled)"><input disabled={namedSchedule} step="0.001" type="datetime-local" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="Repeat"><select disabled={namedSchedule} className={inputCls} value={frequency} onChange={(e) => setFrequency(e.target.value)}>
          <option value="once">Run once</option>
          <option value="MINUTELY">Every few minutes</option>
          <option value="HOURLY">Hourly</option>
          <option value="DAILY">Daily</option>
          <option value="WEEKLY">Weekly</option>
          <option value="MONTHLY">Monthly</option>
          <option value="custom">Custom schedule</option>
        </select></Field>
        {frequency !== "once" && frequency !== "custom" && <>
          <Field label={`Every (${({ MINUTELY: "minutes", HOURLY: "hours", DAILY: "days", WEEKLY: "weeks", MONTHLY: "months" } as Record<string, string>)[frequency]})`}>
            <input disabled={namedSchedule} type="number" min={1} max={99} step={1} className={inputCls} value={interval} onChange={(e) => setInterval(e.target.value)} />
          </Field>
          <p className="text-[12px] text-mute">Repeats from the start date and time. Leave the start date blank to start when enabled.</p>
        </>}
        {frequency === "custom" && <Field label="Oracle schedule expression"><input disabled={namedSchedule} className={inputCls} value={customRepeat} onChange={(e) => setCustomRepeat(e.target.value)} placeholder="FREQ=DAILY;BYHOUR=2;BYMINUTE=0;BYSECOND=0" /></Field>}
        {!validRepeat && <p className="text-[12px] text-err">{frequency === "custom" ? "Enter a schedule expression." : "Enter a whole number from 1 to 99."}</p>}
        <Field label="Comments"><input className={inputCls} value={comments} onChange={(e) => setComments(e.target.value)} /></Field>
        <label className="flex gap-2 text-[12px]"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Enable after creation{enabled && !start ? " (may run immediately)" : ""}</label>
        <label className="flex gap-2 text-[12px]"><input type="checkbox" checked={autoDrop} onChange={(e) => setAutoDrop(e.target.checked)} />Automatically drop after completion</label>
      </fieldset>
      <details><summary className="cursor-pointer text-[12px] text-accenthi">Preview SQL</summary><pre className="mt-2 p-3 bg-panel2 rounded text-[11px] whitespace-pre-wrap break-all">{statement}</pre></details>
      {!writable && <p className="text-[12px] text-err">Job creation requires a connected, writable connection and Developer or Administrator access.</p>}
      {error && <p role="alert" className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2"><Btn variant="outline" disabled={busy} onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !loaded || !writable || !validName || (!namedProgram && !action.trim()) || !validDate || !validRepeat} onClick={() => void create()}>{busy ? "Creating…" : "Create job"}</Btn></div>
    </div>
  </Modal>;
}
