import { useEffect, useId, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, Database, Search, X } from "lucide-react";
import type { Connection } from "../types";
import { inputCls } from "./ui";

type SortField = "name" | "user" | "host" | "database" | "status";
const statusLabel = (c: Connection) => c.status === "connected" ? "Connected" : c.status === "error" ? "Connection error" : "Not connected";
const endpoint = (c: Connection) => [c.host ? `${c.host}${c.port ? `:${c.port}` : ""}` : "", c.database].filter(Boolean).join(" / ");

/** Search/filter state changes the available options without changing the selected database. */
export default function ConnectionPicker({ connections, value, onChange, label, disabled = false, defaultOpen = false, inlineOptions = false }: {
  connections: Connection[];
  value: string;
  onChange: (id: string) => void;
  label: string;
  disabled?: boolean;
  defaultOpen?: boolean;
  inlineOptions?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [access, setAccess] = useState("all");
  const [sort, setSort] = useState<SortField>("name");
  const [descending, setDescending] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const popupId = useId();
  const selected = connections.find(c => c.id === value);
  const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const filtered = connections.filter(c => {
    const haystack = [c.name, c.user, c.host, c.port, c.database, c.role, statusLabel(c), c.readOnly ? "read-only" : "writable"].join(" ").toLocaleLowerCase();
    return terms.every(term => haystack.includes(term)) &&
      (status === "all" || (c.status ?? "idle") === status) &&
      (access === "all" || (access === "readOnly" ? !!c.readOnly : !c.readOnly));
  }).sort((a, b) => {
    const field = (c: Connection) => sort === "status" ? statusLabel(c) : c[sort] ?? "";
    const order = String(field(a)).localeCompare(String(field(b)), undefined, { numeric: true, sensitivity: "base" }) ||
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || a.id.localeCompare(b.id);
    return descending ? -order : order;
  });
  const activeFilters = terms.length > 0 || status !== "all" || access !== "all";
  const choose = (id: string) => { if (id !== value) onChange(id); setOpen(false); trigger.current?.focus(); };
  useEffect(() => {
    if (!open || disabled) return;
    searchInput.current?.focus();
    const outside = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const focusOutside = (e: FocusEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focusOutside);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", focusOutside); };
  }, [open, disabled]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return <div ref={root} className="relative min-w-0" onKeyDown={e => {
    if (e.key === "Escape" && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}>
    <button ref={trigger} type="button" aria-label={`${label} connection`} aria-expanded={open && !disabled} aria-controls={popupId}
      disabled={disabled} onClick={() => setOpen(!open)}
      className={`w-full flex items-center gap-2.5 rounded-lg border bg-panel px-3 py-2.5 text-left transition-colors disabled:opacity-50 ${open ? "border-accent ring-1 ring-accent/20" : "border-bdr hover:border-accent/60"}`}>
      <Database size={17} className="text-accenthi shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-ink">{selected?.name ?? (value ? "Connection unavailable — choose another" : "Select connection")}</span>
        {selected && <span className="block truncate text-[11px] text-mute mt-0.5">{selected.user}{endpoint(selected) ? ` · ${endpoint(selected)}` : ""}</span>}
      </span>
      {selected && <span className={`text-[10px] shrink-0 ${selected.status === "connected" ? "text-ok" : selected.status === "error" ? "text-err" : "text-mute"}`}>{statusLabel(selected)}{selected.readOnly ? " · Read-only" : ""}</span>}
      <ChevronDown size={14} className={`shrink-0 text-mute transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && !disabled && <section id={popupId} aria-label={`${label} connection options`} className={`${inlineOptions ? "relative" : "absolute left-0 right-0 top-full z-40 shadow-2xl"} mt-1 rounded-lg border border-bdr bg-panel overflow-hidden`}>
      <div className="p-3 space-y-2 border-b border-bdrsoft bg-panel2">
        <div className="relative flex items-center"><Search size={14} className="absolute left-2 text-mute pointer-events-none" />
          <input ref={searchInput} aria-label={`Search ${label} connections`} value={search} placeholder="Search name, schema, host or service…"
            className={`${inputCls} w-full pl-7 pr-7`} onChange={e => setSearch(e.target.value)} onKeyDown={e => {
              if (e.key === "Enter" && filtered.length) { e.preventDefault(); choose(filtered[0].id); }
              if (e.key === "ArrowDown") { e.preventDefault(); root.current?.querySelector<HTMLButtonElement>("[data-connection-option]")?.focus(); }
            }} />
          {search && <button type="button" aria-label={`Clear ${label} connection search`} className="absolute right-2 text-mute hover:text-ink" onClick={() => { setSearch(""); searchInput.current?.focus(); }}><X size={13} /></button>}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[10px] text-mute">Status<select aria-label={`${label} connection status filter`} className={`${inputCls} block w-full mt-1`} value={status} onChange={e => setStatus(e.target.value)}>
            <option value="all">All statuses</option><option value="connected">Connected</option><option value="idle">Not connected</option><option value="error">Connection errors</option>
          </select></label>
          <label className="text-[10px] text-mute">Access<select aria-label={`${label} connection access filter`} className={`${inputCls} block w-full mt-1`} value={access} onChange={e => setAccess(e.target.value)}>
            <option value="all">All connections</option><option value="writable">Writable</option><option value="readOnly">Read-only</option>
          </select></label>
        </div>
        <div className="flex items-end gap-2"><label className="text-[10px] text-mute flex-1 min-w-0">Sort by<select aria-label={`${label} connection sort`} className={`${inputCls} block w-full mt-1`} value={sort} onChange={e => setSort(e.target.value as SortField)}>
          <option value="name">Connection name</option><option value="user">Schema / user</option><option value="host">Host</option><option value="database">Service / database</option><option value="status">Status</option>
        </select></label>
          <button type="button" aria-label={`${label} connection sort direction`} title={descending ? "Descending — switch to ascending" : "Ascending — switch to descending"}
            className="h-7 px-2 rounded border border-bdr text-soft hover:bg-panel3 flex gap-1 items-center" onClick={() => setDescending(!descending)}>
            {descending ? <ArrowDown size={13} /> : <ArrowUp size={13} />}<span className="text-[10px]">{descending ? "Z–A" : "A–Z"}</span>
          </button>
        </div>
      </div>
      <div className="px-3 py-2 flex justify-between items-center text-[10px] text-mute border-b border-bdrsoft">
        <span aria-live="polite">{filtered.length} of {connections.length} connections</span>
        {activeFilters && <button type="button" className="text-accenthi hover:underline" onClick={() => { setSearch(""); setStatus("all"); setAccess("all"); searchInput.current?.focus(); }}>Reset filters</button>}
      </div>
      <div className="max-h-64 overflow-y-auto overscroll-contain p-1" onKeyDown={e => {
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>("[data-connection-option]") ?? [])];
        const index = buttons.indexOf(e.target as HTMLButtonElement);
        if (index < 0) return;
        e.preventDefault();
        buttons[e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}>
        {filtered.map(c => <button type="button" key={c.id} data-connection-option={c.id} aria-pressed={c.id === value}
          onClick={() => choose(c.id)} className={`w-full flex items-center gap-2 rounded-md px-2 py-2 text-left hover:bg-panel3 focus-visible:outline-accent ${c.id === value ? "bg-accentdim" : ""}`}>
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${c.status === "connected" ? "bg-ok" : c.status === "error" ? "bg-err" : "bg-mute"}`} />
          <span className="flex-1 min-w-0"><span className="block truncate font-medium">{c.name}</span><span className="block truncate text-[10px] text-mute">{c.user}{endpoint(c) ? ` · ${endpoint(c)}` : ""}</span>
            <span className="block text-[10px] text-mute">{statusLabel(c)} · {c.readOnly ? "Read-only" : "Writable"}{c.role && c.role !== "default" ? ` · ${c.role}` : ""}</span></span>
          {c.id === value && <Check size={14} className="text-accenthi shrink-0" />}
        </button>)}
        {!filtered.length && <div className="text-center text-mute px-4 py-7">{connections.length ? "No connections match these filters." : "No saved Oracle connections available."}</div>}
      </div>
    </section>}
  </div>;
}
