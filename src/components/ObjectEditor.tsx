import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, FileCode2, Hammer, Lightbulb, Loader2, PenLine, Play } from "lucide-react";
import { useStudio } from "../state/store";
import { api, type ObjectSource } from "../utils/api";
import CodeEditor, { type CodeEditorHandle } from "./CodeEditor";
import { editKey, getEdits, setEdits } from "../utils/editBuffers";
import { hintForError } from "../utils/plsqlHints";
import { Btn, Badge, Spinner } from "./ui";

/** Oracle code types editable + compilable in place (BODY variants are reached via the SPEC/BODY toggle). */
const EDITABLE = new Set(["PROCEDURE", "FUNCTION", "PACKAGE", "TRIGGER", "TYPE", "VIEW"]);
const GITHUB_REPOSITORY_KEY = "dataforge-github-repository";
const GITHUB_FILES_KEY = "dataforge-github-plsql-files";
type GitHubRepository = { url?: string; branch?: string; path?: string };

function configuredRepository(): GitHubRepository | null {
  try {
    const config = JSON.parse(localStorage.getItem(GITHUB_REPOSITORY_KEY) ?? "{}") as GitHubRepository;
    return config.url ? config : null;
  } catch { return null; }
}

/** Keep the Repository tab in sync with a successful server-side GitHub write. */
function recordGitHubFile(name: string, type: string, path: string) {
  try {
    const existing = JSON.parse(localStorage.getItem(GITHUB_FILES_KEY) ?? "[]") as Array<Record<string, unknown>>;
    const file = { id: `${name}-${type}`, name, type, path, state: "Synced", updated: "Just now" };
    localStorage.setItem(GITHUB_FILES_KEY, JSON.stringify([...existing.filter((f) => f.id !== file.id), file]));
  } catch { /* repository history is a convenience; compilation remains successful */ }
}

function plsqlOffset(text: string): { lines: number; cols: number } {
  const m = /\b(procedure|function|package(\s+body)?|trigger|type(\s+body)?|view)\b/i.exec(text);
  if (!m) return { lines: 0, cols: 0 };
  const before = text.slice(0, m.index);
  const nl = before.lastIndexOf("\n");
  return { lines: before.split("\n").length - 1, cols: nl < 0 ? m.index : m.index - nl - 1 };
}

interface PanelError {
  line: number;
  position: number;
  text: string;
  attribute: string; // ERROR | WARNING (as returned by user_errors)
  part: "spec" | "body";
  displayLine: number;
  displayCol: number;
}

type ResultPanel =
  | { kind: "success"; label: string; at: string }
  | { kind: "errors"; label: string; at: string; errors: PanelError[] }
  | { kind: "exec"; message: string; line: number; part: "spec" | "body" };

/** What a diagnostic usually means and what to try — looked up locally, no provider needed. */
function HintBlock({ hint }: { hint: ReturnType<typeof hintForError> }) {
  if (!hint) return null;
  return (
    <div className="ml-4 mr-4 mb-1.5 pl-3 border-l-2 border-warn/50 text-[11.5px] leading-relaxed">
      <p className="text-soft">
        <span className="font-mono font-semibold text-warn">{hint.code}</span> — {hint.meaning}
      </p>
      <p className="text-mute">
        {hint.fix}
      </p>
    </div>
  );
}

/** Same hint, for the single-error "statement failed" panel. */
function ErrorHint({ text }: { text: string }) {
  const hint = hintForError(text);
  if (!hint) return null;
  return (
    <div className="mt-1.5">
      <HintBlock hint={hint} />
    </div>
  );
}

/** In-place PL/SQL editor for live connections: edit, compile (spec/body/all) and
 *  navigate user_errors by clicking them. Non-Oracle / read-only cases fall back to a viewer. */
function LiveObjectEditor({ connId, object, tabId }: { connId: string; object: string; tabId: string }) {
  const s = useStudio();
  const { setTabDirty } = s;
  const conn = s.connections.find((c) => c.id === connId);
  const [src, setSrc] = useState<ObjectSource | null>(null);
  const [fetchErr, setFetchErr] = useState<string | null>(null);
  const memKey = editKey(connId, object);
  const [part, setPartState] = useState<"spec" | "body">(() => getEdits(memKey)?.part ?? "spec");
  const [spec, setSpec] = useState("");
  const [body, setBody] = useState("");
  const [orig, setOrig] = useState({ spec: "", body: "" });
  const [loaded, setLoaded] = useState(false);
  const [compiling, setCompiling] = useState(false);
  const [panel, setPanel] = useState<ResultPanel | null>(null);
  const [activeErr, setActiveErr] = useState<{ part: "spec" | "body"; line: number } | null>(null);
  /** index of the error row whose hint is expanded (two errors can share a line) */
  const [hintIdx, setHintIdx] = useState<number | null>(null);
  const editorRef = useRef<CodeEditorHandle>(null);

  useEffect(() => {
    let alive = true;
    api.source(connId, object)
      .then((r) => {
        if (!alive) return;
        setSrc(r);
        const specSrc = r.source ?? "";
        const bodySrc = r.bodySource ?? "";
        setOrig({ spec: specSrc, body: bodySrc });
        const mem = getEdits(memKey);
        setSpec(mem?.spec ?? specSrc);
        setBody(mem?.body ?? bodySrc);
        setLoaded(true);
      })
      .catch((e: Error) => { if (alive) setFetchErr(e.message); });
    return () => { alive = false; };
  }, [connId, object, memKey]);

  // keep in-progress edits + selected part while this tab is unmounted (inactive tabs unmount)
  useEffect(() => {
    if (loaded) setEdits(memKey, { spec, body, part });
  }, [memKey, spec, body, part, loaded]);

  const dirtySpec = loaded && spec !== orig.spec;
  const dirtyBody = loaded && body !== orig.body;
  const dirty = dirtySpec || dirtyBody;
  useEffect(() => {
    setTabDirty(tabId, dirty);
  }, [setTabDirty, tabId, dirty]);

  const type = src?.type ?? null;
  const hasParts = type === "PACKAGE" || type === "TYPE";
  const hasBody = src?.bodySource != null;
  const showingBody = hasParts && part === "body" && hasBody;
  const text = showingBody ? body : spec;
  // Oracle-maintained schemas (SYS, SYSTEM, XDB…) are viewers only: nothing else in the
  // tree distinguishes SYS.STANDARD from your own package, and recompiling a dictionary
  // object can leave the instance unusable. The backend refuses these too.
  const systemObject = src?.systemObject === true;
  const canWrite = s.accessRole === "Administrator" || s.accessRole === "Developer";
  const editable = canWrite && !conn?.readOnly && !!type && EDITABLE.has(type) && !systemObject;
  const effType = type ? (showingBody ? `${type} BODY` : type) : null;

  const setPart = (p: "spec" | "body") => {
    setPartState(p);
    setActiveErr(null);
    setHintIdx(null);
  };

  const onEdit = (v: string) => {
    (showingBody ? setBody : setSpec)(v);
    setActiveErr(null);
    setHintIdx(null);
  };

  /** Save & compile: runs each part's CREATE OR REPLACE (auto-versioned by the backend),
   *  then ALTER … COMPILE to read the fresh status + user_errors.
   *  Both calls are acknowledged (`true`) because the dialog in `compile` already named them. */
  const runCompile = async (parts: ("spec" | "body")[]) => {
    if (!type || compiling) return;
    setCompiling(true);
    setPanel(null);
    setActiveErr(null);
    setHintIdx(null);
    try {
      const collected: PanelError[] = [];
      const statuses: string[] = [];
      for (const p of parts) {
        const source = p === "body" ? body : spec;
        const t = p === "body" ? `${type} BODY` : type;
        const q = await api.query(connId, source, true);
        const qe = q.error;
        if (qe) {
          // the statement itself failed (bad CREATE line, read-only, …) — nothing was saved
          setPanel({ kind: "exec", message: `${qe.code}: ${qe.message}`, line: qe.line, part: p });
          if (p !== part) setPartState(p);
          setActiveErr({ part: p, line: qe.line });
          requestAnimationFrame(() => editorRef.current?.goTo(qe.line, 1));
          return;
        }
        const v = q.versioned;
        if (v && v.action !== "UNCHANGED" && v.version != null) {
          s.toast("info", `${v.type} ${v.name} saved as v${v.version} in version history`);
        }
        setOrig((o) => (p === "body" ? { ...o, body: source } : { ...o, spec: source }));
        const r = await api.compile(connId, object, t, true);
        statuses.push(`${r.type} ${r.status}`);
        // GitHub is deliberately best-effort: the database compile is authoritative, and a
        // missing token/network problem must not make a successful Oracle compile look failed.
        const repo = configuredRepository();
        if (repo && r.errors.length === 0) {
          try {
            const synced = await api.githubSync({ repositoryUrl: repo.url!, branch: repo.branch || "main", directory: repo.path || "database/plsql", object, type: t, source });
            recordGitHubFile(object, t, synced.path);
            s.toast("info", `GitHub synced ${synced.path}${synced.commit ? ` · ${synced.commit.slice(0, 7)}` : ""}`);
          } catch (syncError) {
            s.toast("warning", `Compiled, but GitHub was not updated: ${(syncError as Error).message}`);
          }
        }
        const off = plsqlOffset(source);
        collected.push(
          ...r.errors.map((e) => ({
            ...e,
            part: p,
            displayLine: e.line + off.lines,
            displayCol: e.line === 1 ? e.position + off.cols : e.position,
          }))
        );
      }
      const at = new Date().toLocaleTimeString();
      const label = statuses.join(" · ");
      if (collected.length === 0) {
        setPanel({ kind: "success", label, at });
        s.toast("success", `${label} — compiled successfully`);
      } else {
        setPanel({ kind: "errors", label, at, errors: collected });
        s.toast("warning", `${collected.length} problem(s) — click one below to jump to it`);
      }
      s.bumpSchema(); // Versions tab + sidebar tree pick up the new state
    } catch (e) {
      s.toast("error", `Compile failed: ${(e as Error).message}`);
    } finally {
      setCompiling(false);
    }
  };

  /** Compiling overwrites the object that is live in the database — name it before running it. */
  const compile = (parts: ("spec" | "body")[]) => {
    if (!type || compiling) return;
    const what =
      parts.length > 1 ? `${type} ${object} (spec and body)` : parts[0] === "body" ? `${type} BODY ${object}` : `${type} ${object}`;
    s.askConfirm({
      title: `Save and compile ${object}?`,
      body: `${what} will be written to "${conn?.name ?? "this connection"}" with CREATE OR REPLACE — the version currently in the database is overwritten and dependent objects may go INVALID. The previous source is kept in version history.`,
      confirmLabel: "Save & compile",
      onConfirm: () => {
        void runCompile(parts);
      },
    });
  };

  const jumpTo = (e: PanelError, i: number) => {
    setActiveErr({ part: e.part, line: e.displayLine });
    setHintIdx((cur) => (cur === i ? null : i));
    if (e.part !== part) setPartState(e.part);
    requestAnimationFrame(() => editorRef.current?.goTo(e.displayLine, e.displayCol));
  };

  const problem = fetchErr ?? src?.error ?? (src && !src.source ? "The object has no readable source." : null);

  if (problem) {
    return (
      <div className="h-full p-4 df-fade">
        <div className="border border-err/40 bg-err/8 rounded-lg p-3.5 max-w-2xl flex items-start gap-2 text-[12.5px]">
          <CircleAlert size={15} className="text-err shrink-0 mt-0.5" />
          <span>{problem}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col min-h-0 df-fade">
      {/* toolbar */}
      <div className="flex items-center gap-2.5 px-4 py-2 border-b border-bdrsoft flex-wrap shrink-0">
        <FileCode2 size={16} className="text-accent" />
        <h2 className="font-mono font-semibold text-[14px]">{object}</h2>
        <Badge tone="accent">{effType ?? "…"}</Badge>
        {dirty && !hasParts && <Badge tone="warn">modified</Badge>}
        {hasParts && (
          <div className="flex rounded-md border border-bdr overflow-hidden text-[11px] font-semibold" role="tablist" aria-label="Package component">
            {(["spec", "body"] as const).map((p) => {
              const disabled = p === "body" && !hasBody;
              const pDirty = p === "body" ? dirtyBody : dirtySpec;
              return (
                <button
                  key={p}
                  role="tab"
                  aria-selected={part === p && !disabled}
                  disabled={disabled}
                  title={disabled ? `${type} ${object} has no body` : p === "spec" ? "Specification" : "Body"}
                  onClick={() => setPart(p)}
                  className={`flex items-center gap-1 px-2.5 py-1 uppercase tracking-wide transition-colors ${
                    part === p && !disabled ? "bg-accentdim text-accenthi" : disabled ? "text-mute/50 cursor-not-allowed" : "text-mute hover:text-ink hover:bg-panel2"
                  }`}
                >
                  {p}
                  {pDirty && <span className="w-1.5 h-1.5 rounded-full bg-warn" aria-label={`${p} has unsaved changes`} />}
                </button>
              );
            })}
          </div>
        )}
        <div className="ml-auto flex gap-1.5">
          {canWrite && !systemObject && (type === "PROCEDURE" || type === "FUNCTION" || type === "PACKAGE") && (
            <Btn
              variant="outline"
              onClick={() => s.openTab("run", `${object} (Run)`, object)}
              title={`Run ${object} with parameter values`}
            >
              <Play size={12} /> Run / Test
            </Btn>
          )}
          {editable && hasParts && hasBody && (
            <Btn variant="outline" onClick={() => compile(["spec", "body"])} disabled={compiling} title="Compile specification, then body">
              {compiling ? <Loader2 size={12} className="df-spin" /> : <Hammer size={12} />} Compile All
            </Btn>
          )}
          {editable && (
            <Btn
              variant="primary"
              onClick={() => compile([showingBody ? "body" : "spec"])}
              disabled={compiling || !loaded}
              title={`Save & compile the ${showingBody ? "body" : hasParts ? "specification" : "source"} (Ctrl+Enter)`}
            >
              {compiling ? <Loader2 size={12} className="df-spin" /> : <Hammer size={12} />} {compiling ? "Compiling…" : "Compile"}
            </Btn>
          )}
          {!editable && loaded && text && (
            <Btn
              variant="primary"
              onClick={() => {
                s.setSql(text);
                s.openTab("worksheet", "Worksheet 1");
                s.toast("info", `${effType ?? "Object"} ${object} loaded — edit and run it (code objects are auto-versioned)`);
              }}
            >
              <PenLine size={12} /> Edit in worksheet
            </Btn>
          )}
        </div>
      </div>

      {/* editor */}
      {!loaded ? (
        <div className="p-4">
          <Spinner label={`Reading ${object} from the data dictionary…`} />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <CodeEditor
            ref={editorRef}
            value={text}
            onChange={onEdit}
            readOnly={!editable}
            errorLine={activeErr && activeErr.part === (showingBody ? "body" : "spec") ? activeErr.line : null}
            onCompile={editable ? () => compile([showingBody ? "body" : "spec"]) : undefined}
            ariaLabel={`${effType ?? "Object"} ${object} source`}
          />
        </div>
      )}

      {/* compilation results panel */}
      {loaded && (
        <div className="shrink-0 border-t border-bdr bg-panel max-h-56 overflow-auto">
          {!panel ? (
            <p className="px-4 py-2 text-[11.5px] text-mute">
              {editable
                ? "Edit the source in place and press Compile (Ctrl+Enter) — the CREATE OR REPLACE is executed and auto-versioned, and errors from USER_ERRORS appear here. Click an error to jump to it and see a local diagnostic hint."
                : conn?.readOnly
                  ? "This connection is read-only — the source is shown for inspection only."
                  : systemObject
                    ? `${conn?.user?.toUpperCase() ?? "This"} is an Oracle-maintained schema — dictionary objects are shown read-only, because recompiling one can leave the instance unusable. Use "Edit in worksheet" if you really intend to.`
                    : "Source shown read-only — use \"Edit in worksheet\" to modify it."}
            </p>
          ) : panel.kind === "success" ? (
            <div className="flex items-center gap-2 px-4 py-2.5 text-[12.5px] text-ok">
              <CheckCircle2 size={15} /> Compiled successfully — {panel.label}
              <span className="text-mute text-[11px] ml-1">at {panel.at}</span>
            </div>
          ) : panel.kind === "exec" ? (
            <div className="px-4 py-2.5">
              <div className="flex items-start gap-2">
                <button
                  className="flex-1 text-left flex items-start gap-2 text-[12.5px] hover:bg-panel2 rounded px-1 -mx-1"
                  onClick={() => {
                    setActiveErr({ part: panel.part, line: panel.line });
                    if (panel.part !== part) setPartState(panel.part);
                    requestAnimationFrame(() => editorRef.current?.goTo(panel.line, 1));
                  }}
                  title="Jump to the reported line"
                >
                  <CircleAlert size={15} className="text-err shrink-0 mt-0.5" />
                  <span>
                    <span className="text-err font-semibold">Statement failed</span> — nothing was saved.{" "}
                    <span className="font-mono">{panel.message}</span>{" "}
                    <span className="text-mute">(line {panel.line})</span>
                  </span>
                </button>
              </div>
              <ErrorHint text={panel.message} />
            </div>
          ) : (
            <div>
              <div className="flex items-center gap-2 px-4 pt-2.5 pb-1.5 text-[12.5px] text-err font-semibold sticky top-0 bg-panel">
                <CircleAlert size={14} /> {panel.errors.length} problem(s) — {panel.label}
                <span className="text-mute text-[11px] font-normal ml-1">at {panel.at}</span>
              </div>
              <ul>
                {panel.errors.map((e, i) => {
                  const hint = hintForError(e.text);
                  return (
                    <li key={i}>
                      <button
                        className="w-full text-left flex items-center gap-2 px-4 py-1 text-[12px] font-mono text-soft hover:bg-panel2 transition-colors"
                        onClick={() => jumpTo(e, i)}
                        title={
                          hint
                            ? `Go to line ${e.displayLine}, column ${e.displayCol} — and show what ${hint.code} usually means`
                            : `Go to line ${e.displayLine}, column ${e.displayCol}`
                        }
                      >
                        <Badge tone={e.attribute === "WARNING" ? "warn" : "err"}>{e.attribute === "WARNING" ? "WARN" : "ERROR"}</Badge>
                        {hasParts && <span className="text-[10px] uppercase text-mute w-9">{e.part}</span>}
                        <span className="text-mute shrink-0">
                          {e.displayLine}:{e.displayCol}
                        </span>
                        <span className="truncate">{e.text}</span>
                        {hint && (
                          <Lightbulb
                            size={12}
                            className={`ml-auto shrink-0 ${hintIdx === i ? "text-warn" : "text-mute"}`}
                            aria-label="Suggested fix available"
                          />
                        )}
                      </button>
                      {hintIdx === i && hint && <HintBlock hint={hint} />}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

/** Every connection is live, so the source always comes from the data dictionary.
 *  The old mock branch (sample tables + canned DDL) was unreachable and is gone. */
export default function ObjectEditor({ object, tabId }: { object: string; tabId: string }) {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  if (conn?.live) return <LiveObjectEditor key={`${conn.id}.${object}`} connId={conn.id} object={object} tabId={tabId} />;
  return (
    <div className="h-full grid place-items-center p-6 text-center text-[12.5px] text-mute">
      <p>
        No connection selected — pick one in the sidebar to open{" "}
        <span className="font-mono text-soft">{object}</span>.
      </p>
    </div>
  );
}
