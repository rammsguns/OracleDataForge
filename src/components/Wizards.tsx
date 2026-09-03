import { useState } from "react";
import { ArrowRight, CheckCircle2, ChevronLeft, ChevronRight, Download, FileSpreadsheet, KeyRound, Loader2, PlugZap, ShieldAlert, XCircle } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type ImportPreview, type ImportRequest, type ImportResult } from "../utils/api";
import { inferType, parseFile, toIdentifier, type ParsedTable } from "../utils/importData";
import { download } from "../utils/sql";
import type { Engine } from "../types";
import { Btn, Field, inputCls, Modal } from "./ui";

export function ConnectionWizard() {
  const s = useStudio();
  const editing = s.editingConn;
  const minStep = 1;
  const [step, setStep] = useState(minStep);
  const engine: Engine = "oracle";
  const [name, setName] = useState(editing?.name ?? "");
  const [host, setHost] = useState(editing && editing.host !== "local file" ? editing.host : "");
  const [port, setPort] = useState(editing?.port ?? 1521);
  const [user, setUser] = useState(editing && editing.user !== "—" ? editing.user : "");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState(editing?.database ?? "");
  // new connections start read-only: writing to a database you just pointed at should be
  // a deliberate choice, so the checkbox is on until the user turns it off
  const [readOnly, setReadOnly] = useState(editing?.readOnly ?? true);
  const [testing, setTesting] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testMsg, setTestMsg] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    s.setWizardOpen(false);
    s.setEditingConn(null);
  };
  const canNext = name.trim() && host.trim() && database.trim();

  const liveCfg = () => ({
    name: name.trim(),
    engine,
    host: host.trim(),
    port,
    user: user.trim(),
    password,
    database: database.trim(),
    readOnly,
  });

  const test = async () => {
    setTesting("testing");
    setTestMsg("");
    try {
      // editing an existing live connection with a blank password → backend reuses the stored one
      const r = editing?.live ? await api.testExisting(editing.id, liveCfg()) : await api.test(liveCfg());
      if (r.ok) {
        setTesting("ok");
        setTestMsg(`Connected in ${r.ms} ms — ${r.version}`);
      } else {
        setTesting("fail");
        setTestMsg(r.error ?? "Connection failed");
      }
    } catch (e) {
      setTesting("fail");
      setTestMsg(`Backend unreachable (${(e as Error).message}) — start it with: npm run dev:server`);
    }
  };

  const save = async () => {
    if (editing) {
      const patched = {
        ...editing,
        name: name.trim(),
        host: host.trim(),
        port,
        user: user.trim() || "—",
        database: database.trim() || undefined,
        readOnly,
      };
      setSaving(true);
      try {
        await api.update(editing.id, liveCfg());
        s.updateConnection(patched);
        close();
      } catch (e) {
        setTesting("fail");
        setTestMsg(`Could not save: ${(e as Error).message}`);
      } finally {
        setSaving(false);
      }
      return;
    }
    setSaving(true);
    try {
      const { id } = await api.create(liveCfg());
      s.addConnection({
        id,
        name: name.trim(),
        engine,
        host: host.trim(),
        port,
        user: user.trim() || "—",
        status: "connected",
        color: "#f4b13e",
        live: true,
        database: database.trim(),
        readOnly,
      });
      close();
    } catch (e) {
      setTesting("fail");
      setTestMsg(`Could not save: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const stepLabels = ["Oracle connection", "Verify & save"];
  return (
    <Modal title={editing ? `Edit connection — ${editing.name}` : "New database connection"} onClose={close} width={620}>
      {/* steps indicator */}
      <ol className="flex items-center gap-2 mb-5 text-[11px]" aria-label="Wizard progress">
        {stepLabels.map((label, i) => {
          const actual = i + minStep;
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                  actual < step ? "bg-ok text-white" : actual === step ? "bg-accent text-white" : "bg-panel3 text-mute"
                }`}
                aria-current={actual === step ? "step" : undefined}
              >
                {actual < step ? "✓" : i + 1}
              </span>
              <span className={actual === step ? "text-ink font-semibold" : "text-mute"}>{label}</span>
              {i < stepLabels.length - 1 && <span className="w-8 h-px bg-bdr" />}
            </li>
          );
        })}
      </ol>

      {step === 1 && (
        <div className="space-y-3.5">
          <Field label="Connection name">
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales Analytics (STAGING)" autoFocus />
          </Field>
          <div className="grid grid-cols-[1fr_110px] gap-3">
            <Field label="Host">
              <input className={inputCls} value={host} onChange={(e) => setHost(e.target.value)} placeholder="db.example.corp" />
            </Field>
            <Field label="Port">
              <input className={inputCls} type="number" value={port} onChange={(e) => setPort(+e.target.value)} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Username" hint="SYS connects automatically AS SYSDBA">
              <input className={inputCls} value={user} onChange={(e) => setUser(e.target.value)} placeholder="SYSTEM" autoComplete="off" />
            </Field>
            {/* The saved password is only reused for the endpoint it was saved against — the
                backend refuses to replay it at a different server/port/user (see S3 in the
                security pass), so the hint has to say when blank still works. */}
            <Field label="Password" hint={editing?.live ? "Leave blank to keep the saved password — required again if you change the server, port or user" : undefined}>
              <input className={inputCls} type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={editing?.live ? "(unchanged)" : "••••••••"} autoComplete="new-password" />
            </Field>
          </div>
          <Field label="Service name" hint="Required — the Oracle service to connect to, e.g. FREEPDB1 on Oracle Database Free 23ai. Credentials are held in the backend only, never in the browser.">
            <input className={inputCls} value={database} onChange={(e) => setDatabase(e.target.value)} placeholder="FREEPDB1" />
          </Field>
          <label className="flex items-start gap-2.5 border border-bdr rounded-lg p-3 cursor-pointer hover:border-accent/50 transition-colors">
            <input
              type="checkbox"
              checked={readOnly}
              onChange={(e) => setReadOnly(e.target.checked)}
              className="mt-0.5 accent-[var(--accent)]"
              aria-label="Read-only connection"
            />
            <span>
              <span className="text-[12.5px] font-semibold text-ink">Read-only connection</span>
              <span className="block text-[11px] text-mute mt-0.5">
                Only SELECT / SHOW / DESCRIBE / EXPLAIN statements are allowed — INSERT, UPDATE, DELETE and DDL are blocked
                by the backend before reaching the server. Ideal for production databases.
              </span>
            </span>
          </label>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          <div className="border border-bdr rounded-xl p-4 text-[12.5px] space-y-1.5">
            <div><span className="text-mute w-24 inline-block">Engine</span> <b>Oracle</b> <span className="text-[10px] font-bold bg-ok/15 text-ok rounded px-1 py-0.5 ml-1">LIVE</span></div>
            <div><span className="text-mute w-24 inline-block">Name</span> <b>{name}</b></div>
            <div><span className="text-mute w-24 inline-block">Target</span> <span className="font-mono">{`${host}:${port}`}</span></div>
            <div>
              <span className="text-mute w-24 inline-block">Service</span>{" "}
              <span className="font-mono">{database}</span>
            </div>
            <div><span className="text-mute w-24 inline-block">User</span> <span className="font-mono">{user || "—"}</span></div>
            <div>
              <span className="text-mute w-24 inline-block">Access</span>{" "}
              {readOnly ? (
                <span className="text-[10px] font-bold bg-warn/15 text-warn rounded px-1 py-0.5">READ-ONLY</span>
              ) : (
                <span>read / write</span>
              )}
            </div>
          </div>
          <div className="flex items-start gap-3 flex-wrap">
            <Btn variant="outline" onClick={test} disabled={testing === "testing"}>
              {testing === "testing" ? <Loader2 size={13} className="df-spin" /> : <PlugZap size={13} />}
              Test connection
            </Btn>
            {testing === "ok" && (
              <span className="flex items-center gap-1.5 text-ok text-[12px] df-fade pt-1.5">
                <CheckCircle2 size={14} /> {testMsg}
              </span>
            )}
            {testing === "fail" && (
              <span className="flex items-start gap-1.5 text-err text-[12px] df-fade pt-1.5 max-w-full break-words">
                <XCircle size={14} className="shrink-0 mt-0.5" /> {testMsg}
              </span>
            )}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between mt-6 pt-4 border-t border-bdrsoft">
        <Btn variant="ghost" onClick={() => (step === minStep ? close() : setStep((x) => x - 1))}>
          <ChevronLeft size={13} /> {step === minStep ? "Cancel" : "Back"}
        </Btn>
        {step < 2 ? (
          <Btn variant="primary" onClick={() => setStep((x) => x + 1)} disabled={!canNext}>
            Next <ChevronRight size={13} />
          </Btn>
        ) : (
          <Btn variant="primary" onClick={save} disabled={!name.trim() || saving}>
            {saving ? <Loader2 size={13} className="df-spin" /> : <CheckCircle2 size={13} />} {editing ? "Save changes" : "Save connection"}
          </Btn>
        )}
      </div>
    </Modal>
  );
}

export function ImportWizard() {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const engine = conn?.engine ?? "oracle";
  const close = () => s.setImportOpen(false);

  const [step, setStep] = useState<"file" | "configure" | "done">("file");
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedTable | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [tables, setTables] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [newTable, setNewTable] = useState("IMPORTED_DATA");
  const [targetCols, setTargetCols] = useState<string[]>([]);
  const [mapping, setMapping] = useState<(string | null)[]>([]);
  const [newTypes, setNewTypes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setParseError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const p = parseFile(file.name, String(reader.result ?? ""));
        if (!p.rows.length) throw new Error("The file has a header but no data rows.");
        setParsed(p);
        setNewTypes(p.columns.map((_, i) => inferType(p.rows.map((r) => r[i]), engine)));
      } catch (e) {
        setParsed(null);
        setParseError((e as Error).message);
      }
    };
    reader.onerror = () => setParseError("Could not read the file.");
    reader.readAsText(file);
  };

  const loadTargetCols = async (t: string) => {
    if (!conn || !t || !parsed) return;
    try {
      const r = await api.query(conn.id, `SELECT * FROM ${t} WHERE 1=0`);
      const cols = r.columns ?? [];
      setTargetCols(cols);
      setMapping(parsed.columns.map((fc) => cols.find((tc) => tc.toLowerCase() === fc.toLowerCase()) ?? null));
    } catch (e) {
      setTargetCols([]);
      s.toast("error", (e as Error).message);
    }
  };

  const goConfigure = async () => {
    setStep("configure");
    if (!conn) return;
    try {
      const sch = await api.schema(conn.id);
      const names = sch.tables.map((t) => t.name);
      setTables(names);
      const def = s.selectedObject && names.includes(s.selectedObject) ? s.selectedObject : names[0] ?? "";
      setTarget(def);
      if (def) await loadTargetCols(def);
    } catch (e) {
      s.toast("error", (e as Error).message);
    }
  };

  const runImport = async () => {
    if (!conn || !parsed) return;
    let payload: ImportRequest;
    if (mode === "new") {
      if (!newTable.trim()) { s.toast("warning", "Enter a name for the new table"); return; }
      // sanitize + de-duplicate the generated column identifiers
      const seen = new Map<string, number>();
      const columns = parsed.columns.map((c) => {
        let id = toIdentifier(c, engine);
        const n = seen.get(id.toUpperCase()) ?? 0;
        seen.set(id.toUpperCase(), n + 1);
        if (n) id = `${id}_${n + 1}`;
        return id;
      });
      payload = { table: newTable.trim(), createNew: true, columns, types: newTypes, rows: parsed.rows };
    } else {
      const idxs = mapping.map((m, i) => (m ? i : -1)).filter((i) => i >= 0);
      if (!idxs.length) { s.toast("warning", "Map at least one column to the target table"); return; }
      payload = {
        table: target,
        createNew: false,
        columns: idxs.map((i) => mapping[i]!),
        rows: parsed.rows.map((r) => idxs.map((i) => r[i])),
      };
    }
    // an import writes rows (and may create a table) — confirm before anything reaches the DB
    s.askConfirm({
      title: `Import ${payload.rows.length.toLocaleString()} row(s) into ${payload.table}?`,
      body: `${payload.rows.length.toLocaleString()} row(s) will be inserted into ${payload.table} on "${conn.name}"${
        payload.createNew ? ` — the table will be created first with ${payload.columns.length} column(s)` : ""
      }. Inserted rows are not rolled back automatically.`,
      confirmLabel: "Import rows",
      onConfirm: () => void doImport(payload),
    });
  };

  const doImport = async (payload: ImportRequest) => {
    if (!conn) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await api.importData(conn.id, payload, true);
      setResult(res);
      setStep("done");
      if (res.ok) {
        s.toast("success", `Imported ${res.inserted.toLocaleString()} row(s) into ${res.table}`);
        s.bumpSchema();
      } else {
        s.toast("error", res.error ?? "Import failed");
      }
    } catch (e) {
      setResult({ ok: false, created: false, inserted: 0, table: payload.table, error: (e as Error).message });
      setStep("done");
      s.toast("error", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // --- guards ---
  if (!conn) {
    return (
      <Modal title="Import CSV / JSON" onClose={close} width={460}>
        <p className="text-[12.5px] text-mute">Select a live connection in the sidebar first — imports run against the active connection.</p>
        <div className="flex justify-end pt-4"><Btn variant="primary" onClick={close}>Close</Btn></div>
      </Modal>
    );
  }
  if (conn.readOnly) {
    return (
      <Modal title="Import CSV / JSON" onClose={close} width={460}>
        <p className="text-[12.5px] text-mute"><b className="text-ink">{conn.name}</b> is read-only. Edit the connection and disable read-only mode to import data into it.</p>
        <div className="flex justify-end pt-4"><Btn variant="primary" onClick={close}>Close</Btn></div>
      </Modal>
    );
  }

  const preview = parsed ? parsed.rows.slice(0, 5) : [];

  return (
    <Modal title={`Import CSV / JSON → ${conn.name}`} onClose={close} width={660}>
      {/* step 1: file */}
      {step === "file" && (
        <div className="space-y-4">
          <label
            className="border-2 border-dashed border-bdr rounded-xl p-6 flex flex-col items-center gap-2 cursor-pointer hover:border-accent/60 hover:bg-accentdim transition-colors"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}
          >
            <FileSpreadsheet size={26} className="text-accent" />
            <span className="text-[12.5px] font-semibold">{fileName ?? "Drop a .csv or .json file here"}</span>
            <span className="text-[11px] text-mute">or click to browse — the file is parsed in your browser before anything is written</span>
            <input type="file" accept=".csv,.json,text/csv,application/json" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} aria-label="Choose file to import" />
          </label>

          {parseError && (
            <div className="border border-err/40 bg-err/8 rounded-lg p-2.5 text-[12px] text-ink flex items-start gap-2">
              <XCircle size={14} className="text-err shrink-0 mt-0.5" /> {parseError}
            </div>
          )}

          {parsed && (
            <div>
              <div className="text-[11.5px] text-soft mb-1.5">
                <b className="text-ink">{parsed.columns.length}</b> column(s), <b className="text-ink">{parsed.rows.length.toLocaleString()}</b> row(s) detected. Preview:
              </div>
              <div className="border border-bdr rounded-lg overflow-auto max-h-52">
                <table className="w-full text-left border-collapse text-[11px]">
                  <thead>
                    <tr className="border-b border-bdr text-mute">
                      {parsed.columns.map((c, i) => <th key={i} className="px-2 py-1 font-semibold whitespace-nowrap">{c}</th>)}
                    </tr>
                  </thead>
                  <tbody className="[&>tr]:border-b [&>tr]:border-bdrsoft font-mono">
                    {preview.map((r, ri) => (
                      <tr key={ri}>
                        {parsed.columns.map((_, ci) => <td key={ci} className="px-2 py-1 whitespace-nowrap text-soft max-w-40 overflow-hidden text-ellipsis">{r[ci] ?? <span className="text-mute italic">null</span>}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t border-bdrsoft">
            <Btn variant="ghost" onClick={close}>Cancel</Btn>
            <Btn variant="primary" onClick={goConfigure} disabled={!parsed}>
              Next <ChevronRight size={13} />
            </Btn>
          </div>
        </div>
      )}

      {/* step 2: configure */}
      {step === "configure" && parsed && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => setMode("existing")} aria-pressed={mode === "existing"} className={`border rounded-lg p-3 text-left transition-colors ${mode === "existing" ? "border-accent bg-accentdim" : "border-bdr"}`}>
              <div className="text-[12.5px] font-semibold">Existing table</div>
              <div className="text-[11px] text-mute mt-0.5">Map file columns onto a table in {conn.name}</div>
            </button>
            <button onClick={() => setMode("new")} aria-pressed={mode === "new"} className={`border rounded-lg p-3 text-left transition-colors ${mode === "new" ? "border-accent bg-accentdim" : "border-bdr"}`}>
              <div className="text-[12.5px] font-semibold">New table</div>
              <div className="text-[11px] text-mute mt-0.5">Create a table with types inferred from the file</div>
            </button>
          </div>

          {mode === "existing" ? (
            <div className="space-y-3">
              <Field label="Target table">
                <select
                  className={inputCls}
                  value={target}
                  onChange={(e) => { setTarget(e.target.value); void loadTargetCols(e.target.value); }}
                  aria-label="Target table"
                >
                  {tables.length === 0 && <option value="">(no tables)</option>}
                  {tables.map((t) => <option key={t}>{t}</option>)}
                </select>
              </Field>
              <div>
                <div className="text-[11px] font-semibold text-soft mb-1 uppercase tracking-wider">Column mapping</div>
                <div className="border border-bdr rounded-lg divide-y divide-bdrsoft max-h-56 overflow-auto">
                  {parsed.columns.map((fc, i) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                      <span className="font-mono text-soft flex-1 truncate" title={fc}>{fc}</span>
                      <ArrowRight size={12} className="text-mute shrink-0" />
                      <select
                        className="h-7 px-2 rounded-md bg-panel2 border border-bdr text-[12px] focus:border-accent focus:outline-none flex-1 min-w-0"
                        value={mapping[i] ?? ""}
                        onChange={(e) => setMapping((m) => m.map((v, j) => (j === i ? (e.target.value || null) : v)))}
                        aria-label={`Map ${fc}`}
                      >
                        <option value="">— skip —</option>
                        {targetCols.map((tc) => <option key={tc} value={tc}>{tc}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
                <div className="text-[11px] text-mute mt-1">{mapping.filter(Boolean).length} of {parsed.columns.length} column(s) mapped. Unmapped columns are skipped.</div>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <Field label="New table name">
                <input className={inputCls} value={newTable} onChange={(e) => setNewTable(e.target.value)} aria-label="New table name" spellCheck={false} />
              </Field>
              <div>
                <div className="text-[11px] font-semibold text-soft mb-1 uppercase tracking-wider">Columns &amp; inferred types</div>
                <div className="border border-bdr rounded-lg divide-y divide-bdrsoft max-h-56 overflow-auto">
                  {parsed.columns.map((fc, i) => (
                    <div key={i} className="flex items-center gap-2 px-2.5 py-1.5 text-[12px]">
                      <span className="font-mono text-soft flex-1 truncate" title={fc}>{toIdentifier(fc, engine)}</span>
                      <input
                        className="h-7 px-2 rounded-md bg-panel2 border border-bdr text-[12px] font-mono focus:border-accent focus:outline-none w-44"
                        value={newTypes[i] ?? ""}
                        onChange={(e) => setNewTypes((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
                        aria-label={`Type for ${fc}`}
                        spellCheck={false}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="flex justify-between gap-2 pt-2 border-t border-bdrsoft">
            <Btn variant="ghost" onClick={() => setStep("file")}><ChevronLeft size={13} /> Back</Btn>
            <Btn variant="primary" onClick={runImport} disabled={busy}>
              {busy ? <Loader2 size={13} className="df-spin" /> : null}
              {busy ? "Importing…" : `Import ${parsed.rows.length.toLocaleString()} row(s)`}
            </Btn>
          </div>
        </div>
      )}

      {/* step 3: done */}
      {step === "done" && result && (
        <div className="space-y-4">
          {result.ok ? (
            <div className="border border-ok/40 bg-ok/8 rounded-lg p-4 flex items-start gap-2.5">
              <CheckCircle2 size={18} className="text-ok shrink-0 mt-0.5" />
              <div className="text-[12.5px]">
                <div className="font-semibold text-ink">Imported {result.inserted.toLocaleString()} row(s) into {result.table}.</div>
                <div className="text-mute mt-0.5">{result.created ? "The table was created and populated." : "Rows were appended to the existing table."}</div>
              </div>
            </div>
          ) : (
            <div className="border border-err/40 bg-err/8 rounded-lg p-4 flex items-start gap-2.5">
              <XCircle size={18} className="text-err shrink-0 mt-0.5" />
              <div className="text-[12.5px]">
                <div className="font-semibold text-ink">Import failed.</div>
                <div className="text-ink font-mono mt-1 whitespace-pre-wrap">{result.error}</div>
              </div>
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2 border-t border-bdrsoft">
            {!result.ok && <Btn variant="outline" onClick={() => setStep("configure")}><ChevronLeft size={13} /> Back</Btn>}
            <Btn variant="primary" onClick={close}>Done</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function ConfirmDialog() {
  const s = useStudio();
  if (!s.confirm) return null;
  const c = s.confirm;
  return (
    <Modal title={c.title} onClose={s.closeConfirm} width={460}>
      <p className="text-[12.5px] text-soft leading-relaxed">{c.body}</p>
      <div className="flex justify-end gap-2 mt-5">
        <Btn variant="ghost" onClick={s.closeConfirm}>Cancel</Btn>
        <Btn
          variant={c.danger ? "danger" : "primary"}
          onClick={() => {
            c.onConfirm();
            s.closeConfirm();
          }}
        >
          {c.confirmLabel}
        </Btn>
      </div>
    </Modal>
  );
}

/** Passphrase floor, mirroring the backend's. Kept in one place so the hint, the disabled
 *  state and the server's rejection message cannot drift apart. */
const EXPORT_MIN_PASSPHRASE = 12;

/**
 * Export saved connections to an encrypted JSON file.
 *
 * The Oracle passwords are not in the browser — they never leave the backend — so this
 * dialog does not build the file. It sends the passphrase and the selection to the server,
 * which encrypts the connections with a key derived from that passphrase, and downloads
 * whatever comes back. What the user ends up with is a portable backup of connections that
 * otherwise only exist inside this machine's `data/connections.json`.
 */
export function ExportConnectionsDialog() {
  const s = useStudio();
  const exportable = s.connections.filter((c) => c.live);
  const [selected, setSelected] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(exportable.map((c) => [c.id, true]))
  );
  const [pass, setPass] = useState("");
  const [confirmPass, setConfirmPass] = useState("");
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = () => s.setExportConnsOpen(false);
  const chosen = exportable.filter((c) => selected[c.id]);
  const tooShort = pass.length < EXPORT_MIN_PASSPHRASE;
  const mismatch = confirmPass.length > 0 && pass !== confirmPass;
  const canExport = chosen.length > 0 && !tooShort && pass === confirmPass && !busy;

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const ids = chosen.map((c) => c.id);
      const { file, count } = await api.exportConnections(pass, ids);
      const stamp = new Date().toISOString().slice(0, 10);
      download(`dataforge-connections-${stamp}.json`, JSON.stringify(file, null, 2), "application/json");
      s.toast("success", `${count} connection(s) exported — the file is only as safe as the passphrase you chose.`);
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Export connections to an encrypted file" onClose={close} width={620}>
      {exportable.length === 0 ? (
        <p className="text-[12.5px] text-mute">There are no saved connections to export yet.</p>
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-2.5 border border-warn/40 bg-warn/10 rounded-lg p-3 text-[11.5px] text-soft leading-snug">
            <ShieldAlert size={15} className="shrink-0 text-warn mt-0.5" />
            <span>
              The file contains the <b>Oracle username and password</b> of every connection you pick, encrypted with
              AES-256-GCM under a key derived from your passphrase. Anyone who gets both the file and the passphrase gets
              the databases. There is no recovery: lose the passphrase and the file is unreadable.
            </span>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[11px] font-semibold text-soft uppercase tracking-wider">
                Connections ({chosen.length}/{exportable.length})
              </span>
              <button
                className="text-[11px] text-accenthi hover:underline"
                onClick={() =>
                  setSelected(Object.fromEntries(exportable.map((c) => [c.id, chosen.length !== exportable.length])))
                }
              >
                {chosen.length === exportable.length ? "Clear all" : "Select all"}
              </button>
            </div>
            <ul className="border border-bdr rounded-lg divide-y divide-bdrsoft max-h-52 overflow-auto">
              {exportable.map((c) => (
                <li key={c.id}>
                  <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-panel2">
                    <input
                      type="checkbox"
                      className="accent-[var(--accent)]"
                      checked={!!selected[c.id]}
                      onChange={(e) => setSelected((m) => ({ ...m, [c.id]: e.target.checked }))}
                    />
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-ink truncate">{c.name}</span>
                      <span className="block text-[11px] text-mute font-mono truncate">
                        {c.host}:{c.port}
                        {c.database ? `/${c.database}` : ""} as {c.user}
                        {c.readOnly ? " · read-only" : ""}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Passphrase" hint={`At least ${EXPORT_MIN_PASSPHRASE} characters`}>
              <input
                className={inputCls}
                type={reveal ? "text" : "password"}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoComplete="new-password"
                autoFocus
                placeholder="••••••••••••"
              />
            </Field>
            <Field label="Confirm passphrase">
              <input
                className={inputCls}
                type={reveal ? "text" : "password"}
                value={confirmPass}
                onChange={(e) => setConfirmPass(e.target.value)}
                autoComplete="new-password"
                placeholder="••••••••••••"
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[11.5px] text-mute cursor-pointer">
            <input type="checkbox" className="accent-[var(--accent)]" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
            Show passphrase
          </label>

          {mismatch && (
            <p className="flex items-center gap-1.5 text-err text-[12px]">
              <XCircle size={14} /> The two passphrases do not match.
            </p>
          )}
          {error && (
            <p className="flex items-start gap-1.5 text-err text-[12px] break-words">
              <XCircle size={14} className="shrink-0 mt-0.5" /> {error}
            </p>
          )}

          <div className="flex items-center justify-between pt-4 border-t border-bdrsoft">
            <Btn variant="ghost" onClick={close}>Cancel</Btn>
            <Btn variant="primary" onClick={run} disabled={!canExport}>
              {busy ? <Loader2 size={13} className="df-spin" /> : <Download size={13} />} Export {chosen.length || ""} connection
              {chosen.length === 1 ? "" : "s"}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

/**
 * Import connections from an encrypted export.
 *
 * The browser cannot open the file — the passphrase-derived key never exists here — so the
 * dialog uploads the envelope and lets the backend decrypt it. Two calls, in the order the
 * user thinks in: `preview` says what is inside (metadata only, still no passwords), then
 * `import` writes the entries that were ticked. Nothing lands in the registry until the
 * second call, so a wrong passphrase or the wrong file costs nothing.
 */
export function ImportConnectionsDialog() {
  const s = useStudio();
  const [fileName, setFileName] = useState("");
  const [envelope, setEnvelope] = useState<unknown>(null);
  const [pass, setPass] = useState("");
  const [reveal, setReveal] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picked, setPicked] = useState<Record<number, boolean>>({});
  const [mode, setMode] = useState<"skip" | "replace">("skip");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = () => s.setImportConnsOpen(false);

  const readFile = async (f: File | undefined) => {
    if (!f) return;
    setError("");
    setPreview(null);
    setFileName(f.name);
    try {
      const parsed = JSON.parse(await f.text());
      // named here rather than left to the server so the obvious mistake — picking the wrong
      // .json — is answered before a passphrase is typed
      if (!parsed || parsed.format !== "oracle-dataforge-connections") {
        setEnvelope(null);
        setError(`${f.name} is not an Oracle DataForge connection export.`);
        return;
      }
      setEnvelope(parsed);
    } catch {
      setEnvelope(null);
      setError(`${f.name} is not valid JSON.`);
    }
  };

  const unlock = async () => {
    setBusy(true);
    setError("");
    try {
      const p = await api.previewConnectionImport(envelope, pass);
      setPreview(p);
      // everything importable starts ticked; an entry the server rejected cannot be
      setPicked(Object.fromEntries(p.entries.filter((e) => !e.error).map((e) => [e.index, true])));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chosen = preview?.entries.filter((e) => picked[e.index] && !e.error) ?? [];
  const duplicates = chosen.filter((e) => e.duplicateOfId).length;

  const run = async () => {
    setBusy(true);
    setError("");
    try {
      const r = await api.importConnections(envelope, pass, chosen.map((e) => e.index), mode);
      await s.refreshConnections();
      const parts = [
        r.added.length ? `${r.added.length} added` : "",
        r.replaced.length ? `${r.replaced.length} replaced` : "",
        r.skipped.length ? `${r.skipped.length} skipped` : "",
      ].filter(Boolean);
      s.toast(
        r.added.length || r.replaced.length ? "success" : "info",
        `Import finished — ${parts.join(", ")}. Connect to open a session.`
      );
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Import connections from an encrypted file" onClose={close} width={640}>
      <div className="space-y-4">
        <Field label="Export file" hint="The dataforge-connections-….json written by Export connections">
          <input
            type="file"
            accept="application/json,.json"
            className="w-full text-[12px] text-soft file:mr-3 file:h-7 file:px-2.5 file:rounded-md file:border file:border-bdr file:bg-panel2 file:text-soft file:text-[12px] file:cursor-pointer hover:file:border-accent/60"
            onChange={(e) => void readFile(e.target.files?.[0])}
          />
        </Field>

        {envelope != null && !preview && (
          <>
            <Field label="Passphrase" hint="The one used when the file was exported">
              <input
                className={inputCls}
                type={reveal ? "text" : "password"}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && pass && !busy && void unlock()}
                autoComplete="off"
                autoFocus
                placeholder="••••••••••••"
              />
            </Field>
            <label className="flex items-center gap-2 text-[11.5px] text-mute cursor-pointer">
              <input type="checkbox" className="accent-[var(--accent)]" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />
              Show passphrase
            </label>
          </>
        )}

        {preview && (
          <>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-[11px] font-semibold text-soft uppercase tracking-wider">
                  In {fileName} ({chosen.length}/{preview.entries.length})
                </span>
                {preview.exportedAt && (
                  <span className="text-[11px] text-mute">exported {preview.exportedAt.slice(0, 10)}</span>
                )}
              </div>
              <ul className="border border-bdr rounded-lg divide-y divide-bdrsoft max-h-56 overflow-auto">
                {preview.entries.map((e) => (
                  <li key={e.index}>
                    <label className={`flex items-center gap-2.5 px-3 py-2 ${e.error ? "opacity-60" : "cursor-pointer hover:bg-panel2"}`}>
                      <input
                        type="checkbox"
                        className="accent-[var(--accent)]"
                        disabled={!!e.error}
                        checked={!!picked[e.index]}
                        onChange={(ev) => setPicked((m) => ({ ...m, [e.index]: ev.target.checked }))}
                      />
                      <span className="min-w-0">
                        <span className="flex items-center gap-1.5">
                          <span className="text-[12.5px] font-medium text-ink truncate">{e.name}</span>
                          {e.duplicateOfId && (
                            <span className="text-[10px] font-bold bg-warn/15 text-warn rounded px-1 py-0.5 shrink-0">
                              ALREADY SAVED
                            </span>
                          )}
                        </span>
                        <span className="block text-[11px] text-mute font-mono truncate">
                          {e.host}:{e.port}
                          {e.database ? `/${e.database}` : ""} as {e.user}
                          {e.readOnly ? " · read-only" : ""}
                        </span>
                        {e.error && <span className="block text-[11px] text-err">Cannot import: {e.error}</span>}
                        {e.duplicateOfId && e.duplicateOfName !== e.name && (
                          <span className="block text-[11px] text-mute">saved here as “{e.duplicateOfName}”</span>
                        )}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>

            {duplicates > 0 && (
              <div className="border border-bdr rounded-lg p-3 space-y-2">
                <div className="text-[11px] font-semibold text-soft uppercase tracking-wider">
                  {duplicates} of these already exist here
                </div>
                <p className="text-[11px] text-mute leading-snug">
                  A connection counts as the same one when its server, port, user and service name all match — the same
                  test the backend uses before it will reuse a stored password.
                </p>
                {(["skip", "replace"] as const).map((m) => (
                  <label key={m} className="flex items-start gap-2.5 text-[12px] cursor-pointer">
                    <input
                      type="radio"
                      name="dupe-mode"
                      className="mt-0.5 accent-[var(--accent)]"
                      checked={mode === m}
                      onChange={() => setMode(m)}
                    />
                    <span>
                      <span className="font-medium text-ink">{m === "skip" ? "Keep what is here" : "Replace with the file"}</span>
                      <span className="block text-[11px] text-mute">
                        {m === "skip"
                          ? "Leave the saved connection and its password untouched."
                          : "Overwrite the saved name, password and read-only flag; open sessions are closed."}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </>
        )}

        {error && (
          <p className="flex items-start gap-1.5 text-err text-[12px] break-words">
            <XCircle size={14} className="shrink-0 mt-0.5" /> {error}
          </p>
        )}

        <div className="flex items-center justify-between pt-4 border-t border-bdrsoft">
          <Btn variant="ghost" onClick={close}>Cancel</Btn>
          {preview ? (
            <Btn variant="primary" onClick={run} disabled={busy || chosen.length === 0}>
              {busy ? <Loader2 size={13} className="df-spin" /> : <CheckCircle2 size={13} />} Import {chosen.length || ""}{" "}
              connection{chosen.length === 1 ? "" : "s"}
            </Btn>
          ) : (
            <Btn variant="primary" onClick={unlock} disabled={busy || envelope == null || !pass}>
              {busy ? <Loader2 size={13} className="df-spin" /> : <KeyRound size={13} />} Unlock file
            </Btn>
          )}
        </div>
      </div>
    </Modal>
  );
}
