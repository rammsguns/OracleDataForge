import { useState } from "react";
import { useStudio } from "../state/store";
import { api } from "../utils/api";
import { Btn, Modal } from "./ui";

export default function DisableObjectDialog({ connId, name, kind, schema, onClose, onDone }: {
  connId: string; name: string; kind: "trigger" | "job"; schema: string;
  onClose: () => void; onDone: () => void;
}) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === connId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const writable = !!conn?.live && conn.status === "connected" && !conn.readOnly &&
    (s.accessRole === "Administrator" || s.accessRole === "Developer");
  const quote = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const qualified = `${quote(schema)}.${quote(name)}`;
  const sql = kind === "trigger" ? `ALTER TRIGGER ${qualified} DISABLE;`
    : `BEGIN\n  DBMS_SCHEDULER.DISABLE(\n    name => '${qualified.replace(/'/g, "''")}',\n    force => FALSE\n  );\nEND;`;
  const execute = async (confirmed = false) => {
    if (busy || !writable) return;
    setBusy(true);
    setError("");
    try {
      const result = await api.query(connId, sql, confirmed);
      if (result.confirmation) {
        s.askConfirm({ title: `Disable ${name}?`, body: result.confirmation.body,
          confirmLabel: "Disable", danger: false, onConfirm: () => { void execute(true); } });
        return;
      }
      if (result.error) throw new Error(result.error.message);
      s.toast("success", `${name} disabled`);
      onDone();
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={`Disable ${name}`} width={640} onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-4">
      <p className="text-[12px] text-mute">{kind === "trigger"
        ? "Review the SQL. Disabling this trigger prevents it from firing."
        : "Review the SQL. Disabling this job prevents scheduled runs. A running job must finish before it can be disabled."}</p>
      <pre className="p-3 rounded border border-bdr bg-bg text-[12px] font-mono whitespace-pre-wrap break-all">{sql}</pre>
      {!writable && <p className="text-[12px] text-err">Requires a connected, writable connection and Developer or Administrator access.</p>}
      {error && <p role="alert" className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Btn variant="outline" disabled={busy} onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !writable} onClick={() => void execute()}>{busy ? "Disabling…" : "Disable"}</Btn>
      </div>
    </div>
  </Modal>;
}
