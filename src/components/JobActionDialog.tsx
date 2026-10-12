import { useState } from "react";
import { useStudio } from "../state/store";
import { api } from "../utils/api";
import { Btn, Field, Modal, inputCls } from "./ui";

const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;

export default function JobActionDialog({ connId, name, mode, onClose, onDone }: {
  connId: string; name: string; mode: "drop" | "copy"; onClose: () => void; onDone: () => void;
}) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === connId);
  const [newName, setNewName] = useState(`${name.slice(0, 123)}_COPY`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const drop = mode === "drop";
  const validName = /^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(newName.trim()) && newName.trim().toUpperCase() !== name.toUpperCase();
  const writable = !!conn?.live && conn.status === "connected" && !conn.readOnly &&
    (s.accessRole === "Administrator" || s.accessRole === "Developer");
  const sql = drop
    ? `BEGIN\n  DBMS_SCHEDULER.DROP_JOB(\n    job_name => ${literal(name)},\n    force => FALSE\n  );\nEND;`
    : `BEGIN\n  DBMS_SCHEDULER.COPY_JOB(\n    old_job => ${literal(name)},\n    new_job => ${literal(newName.trim().toUpperCase())}\n  );\nEND;`;
  const execute = async (statement = sql, confirmed = false) => {
    if (busy || !writable || (!drop && !validName)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.query(connId, statement, confirmed);
      if (result.confirmation) {
        s.askConfirm({ title: drop ? `Drop ${name}?` : "Create similar job?", body: result.confirmation.body,
          confirmLabel: drop ? "Drop job" : "Create job", danger: drop,
          onConfirm: () => { void execute(statement, true); } });
        return;
      }
      if (result.error) throw new Error(result.error.message);
      s.toast("success", drop ? `${name} dropped` : "Similar job created (disabled)");
      onDone();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={drop ? `Drop ${name}` : `Create similar to ${name}`} width={640} onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-4">
      <p className="text-[12px] text-mute">{drop
        ? "Review the SQL before permanently removing this job. A running job must finish before it can be dropped."
        : "Copy this job’s definition and arguments under a new name. The new job is disabled so you can review and edit it before enabling it."}</p>
      {!drop && <Field label="New job name"><input className={inputCls} disabled={busy} value={newName} onChange={(e) => setNewName(e.target.value)} /></Field>}
      {!drop && !validName && <p className="text-[12px] text-err">Use a different name starting with a letter, with only letters, digits, _, $, or # (up to 128 characters).</p>}
      <pre className="p-3 rounded border border-bdr bg-bg text-[12px] font-mono whitespace-pre-wrap break-all">{sql}</pre>
      {!writable && <p className="text-[12px] text-err">Requires a connected, writable connection and Developer or Administrator access.</p>}
      {error && <p role="alert" className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2"><Btn variant="outline" disabled={busy} onClick={onClose}>Cancel</Btn>
        <Btn variant={drop ? "danger" : "primary"} disabled={busy || !writable || (!drop && !validName)} onClick={() => void execute()}>{busy ? "Working…" : drop ? "Drop job" : "Create job"}</Btn></div>
    </div>
  </Modal>;
}
