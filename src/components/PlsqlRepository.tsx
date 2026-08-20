import { useMemo, useState } from "react";
import { Check, ChevronRight, CircleDot, FileCode2, FolderGit2, Github, GitCommitHorizontal, GitPullRequest, Plus, Settings2 } from "lucide-react";
import { useStudio } from "../state/store";
import { Badge, Btn, EmptyState, Field, Modal, inputCls } from "./ui";

type RepoConfig = { url: string; branch: string; path: string };
type SourceFile = { id: string; name: string; type: "PACKAGE" | "PROCEDURE" | "FUNCTION" | "TRIGGER"; path: string; state: "Synced" | "Modified" | "Untracked"; updated: string };
type Commit = { id: string; message: string; at: string; files: number };

const CONFIG_KEY = "dataforge-github-repository";
const FILES_KEY = "dataforge-github-plsql-files";
const COMMITS_KEY = "dataforge-github-commits";
const read = <T,>(key: string, fallback: T): T => { try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; } };
const stateTone = (state: SourceFile["state"]): "ok" | "warn" | "neutral" => state === "Synced" ? "ok" : state === "Modified" ? "warn" : "neutral";

function RepoSettings({ config, onSave, onClose }: { config: RepoConfig; onSave: (v: RepoConfig) => void; onClose: () => void }) {
  const [url, setUrl] = useState(config.url);
  const [branch, setBranch] = useState(config.branch || "main");
  const [path, setPath] = useState(config.path || "database/plsql");
  return <Modal title="GitHub repository" onClose={onClose} width={510}><div className="space-y-3.5">
    <p className="text-[12px] text-soft">This connection is optional. Dataforge continues to work without a GitHub repository.</p>
    <Field label="Repository URL" hint="HTTPS or SSH URL, e.g. github.com/acme/oracle-db"><input autoFocus className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/acme/oracle-db" /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="Default branch"><input className={inputCls} value={branch} onChange={(e) => setBranch(e.target.value)} /></Field><Field label="PL/SQL directory"><input className={inputCls} value={path} onChange={(e) => setPath(e.target.value.replace(/^\/+|\/+$/g, ""))} /></Field></div>
    <div className="flex justify-end gap-2 pt-1"><Btn variant="outline" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={() => { onSave({ url: url.trim(), branch: branch.trim() || "main", path: path.trim() || "database/plsql" }); onClose(); }}><Check size={13} /> Save repository</Btn></div>
  </div></Modal>;
}

function AddFile({ onAdd, onClose }: { onAdd: (file: Omit<SourceFile, "id" | "state" | "updated">) => void; onClose: () => void }) {
  const [name, setName] = useState(""); const [type, setType] = useState<SourceFile["type"]>("PACKAGE"); const [path, setPath] = useState("");
  return <Modal title="Track PL/SQL source" onClose={onClose} width={460}><div className="space-y-3.5">
    <Field label="Database object"><input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value.toUpperCase())} placeholder="ORDER_API" /></Field>
    <div className="grid grid-cols-2 gap-3"><Field label="Object type"><select className={inputCls} value={type} onChange={(e) => setType(e.target.value as SourceFile["type"])}>{["PACKAGE", "PROCEDURE", "FUNCTION", "TRIGGER"].map((v) => <option key={v}>{v}</option>)}</select></Field><Field label="Repository path"><input className={inputCls} value={path} onChange={(e) => setPath(e.target.value)} placeholder="orders/order_api.pkb" /></Field></div>
    <div className="flex justify-end gap-2"><Btn variant="outline" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={() => name.trim() && onAdd({ name: name.trim(), type, path: path.trim() || `${name.trim().toLowerCase()}.sql` })}>Add source</Btn></div>
  </div></Modal>;
}

export default function PlsqlRepository() {
  const s = useStudio();
  const [config, setConfig] = useState<RepoConfig>(() => read(CONFIG_KEY, { url: "", branch: "main", path: "database/plsql" }));
  const [files, setFiles] = useState<SourceFile[]>(() => read(FILES_KEY, []));
  const [commits, setCommits] = useState<Commit[]>(() => read(COMMITS_KEY, []));
  const [settings, setSettings] = useState(false); const [adding, setAdding] = useState(false); const [message, setMessage] = useState("");
  const configured = !!config.url;
  const dirty = files.filter((f) => f.state !== "Synced");
  const persistFiles = (next: SourceFile[]) => { setFiles(next); localStorage.setItem(FILES_KEY, JSON.stringify(next)); };
  const saveConfig = (next: RepoConfig) => { setConfig(next); localStorage.setItem(CONFIG_KEY, JSON.stringify(next)); s.toast("success", next.url ? "GitHub repository configured" : "Repository disconnected"); };
  const commit = () => { if (!dirty.length) return s.toast("info", "No PL/SQL changes to commit"); const next = { id: `${Date.now()}`, message: message.trim() || `Update ${dirty.length} PL/SQL source file${dirty.length === 1 ? "" : "s"}`, at: new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }), files: dirty.length }; const list = [next, ...commits]; setCommits(list); localStorage.setItem(COMMITS_KEY, JSON.stringify(list)); persistFiles(files.map((f) => ({ ...f, state: "Synced", updated: "Just now" }))); setMessage(""); s.toast("success", `Commit prepared with ${dirty.length} file${dirty.length === 1 ? "" : "s"}`); };
  const repoLabel = useMemo(() => config.url.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, ""), [config.url]);
  if (!configured) return <><EmptyState icon={<Github />} title="No GitHub repository connected" hint="Optionally connect a repository to track PL/SQL source files, review changes, and prepare commits alongside your database work." action={<Btn variant="primary" onClick={() => setSettings(true)}><Github size={14} /> Connect repository</Btn>} />{settings && <RepoSettings config={config} onSave={saveConfig} onClose={() => setSettings(false)} />}</>;
  return <div className="h-full overflow-y-auto p-4 space-y-4 df-fade">
    <div className="flex items-center gap-2.5 flex-wrap"><div className="w-8 h-8 rounded-lg bg-accentdim text-accenthi grid place-items-center"><FolderGit2 size={17} /></div><div><h2 className="text-[14px] font-semibold">PL/SQL Repository</h2><p className="text-[11.5px] text-mute"><span className="text-soft font-medium">{repoLabel}</span> <span className="mx-1">·</span> {config.branch} <span className="mx-1">·</span> {config.path}</p></div><div className="ml-auto flex gap-1.5"><Btn variant="outline" onClick={() => setSettings(true)}><Settings2 size={13} /> Settings</Btn><Btn variant="primary" onClick={() => setAdding(true)}><Plus size={14} /> Track source</Btn></div></div>
    <div className="grid sm:grid-cols-3 gap-3"><Summary label="Tracked objects" value={String(files.length)} icon={<FileCode2 size={15} />} /><Summary label="Pending changes" value={String(dirty.length)} icon={<CircleDot size={15} />} warn={dirty.length > 0} /><Summary label="Local change notes" value={String(commits.length)} icon={<GitCommitHorizontal size={15} />} /></div>
    <div className="grid xl:grid-cols-[1.45fr_0.85fr] gap-4"><section className="border border-bdr rounded-xl bg-panel overflow-hidden"><div className="h-11 px-4 flex items-center border-b border-bdrsoft"><h3 className="text-[12.5px] font-semibold">Tracked PL/SQL</h3><span className="ml-auto text-[11px] text-mute">Successful compiles sync to GitHub automatically.</span></div>{files.length ? <div className="divide-y divide-bdrsoft">{files.map((f) => <div key={f.id} className="px-4 py-3 flex items-center gap-3"><FileCode2 size={16} className="text-accenthi shrink-0" /><div className="min-w-0"><div className="font-mono text-[12px] text-ink">{f.name} <span className="font-sans text-[10px] text-mute">{f.type}</span></div><div className="font-mono text-[10.5px] text-mute truncate">{f.path}</div></div><div className="ml-auto text-right"><Badge tone={stateTone(f.state)}>{f.state}</Badge><div className="text-[10.5px] text-mute mt-1">{f.updated}</div></div></div>)}</div> : <div className="py-14 text-center text-[12px] text-mute">Compile a package, procedure, function, or trigger to add it automatically.</div>}</section>
      <section className="border border-bdr rounded-xl bg-panel p-4"><div className="flex items-center gap-2"><GitCommitHorizontal size={15} className="text-accenthi" /><h3 className="text-[12.5px] font-semibold">Commit changes</h3></div><p className="text-[11.5px] text-mute mt-1.5">Stage the {dirty.length} pending PL/SQL change{dirty.length === 1 ? "" : "s"} in your repository history.</p><input className={`${inputCls} mt-3`} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Commit message" /><Btn className="w-full justify-center mt-2" variant="primary" disabled={!dirty.length} onClick={commit}><GitCommitHorizontal size={13} /> Commit {dirty.length ? `${dirty.length} file${dirty.length === 1 ? "" : "s"}` : "changes"}</Btn><div className="mt-5 pt-4 border-t border-bdrsoft"><div className="flex items-center gap-2 text-[12px] font-semibold"><GitPullRequest size={14} className="text-accenthi" /> Recent commits</div>{commits.length ? <div className="mt-2 space-y-2">{commits.slice(0, 4).map((c) => <div key={c.id} className="text-[11px]"><div className="text-soft">{c.message}</div><div className="text-mute mt-0.5">{c.at} · {c.files} file{c.files === 1 ? "" : "s"}</div></div>)}</div> : <div className="mt-3 text-[11px] text-mute">No local commits yet.</div>}</div></section></div>
    {settings && <RepoSettings config={config} onSave={saveConfig} onClose={() => setSettings(false)} />}{adding && <AddFile onClose={() => setAdding(false)} onAdd={(v) => { persistFiles([...files, { ...v, id: `${Date.now()}`, state: "Untracked", updated: "Just now" }]); setAdding(false); s.toast("success", `${v.name} added to repository tracking`); }} />}
  </div>;
}

function Summary({ label, value, icon, warn }: { label: string; value: string; icon: React.ReactNode; warn?: boolean }) { return <div className="border border-bdr rounded-xl bg-panel p-3.5"><div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider font-semibold text-mute"><span className={warn ? "text-warn" : "text-accenthi"}>{icon}</span>{label}</div><div className={warn ? "text-[22px] font-bold mt-1 text-warn" : "text-[22px] font-bold mt-1"}>{value}</div></div>; }
