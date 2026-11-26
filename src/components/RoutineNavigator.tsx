import { useMemo, useState } from "react";
import { FileCode2, FunctionSquare, Search, X } from "lucide-react";
import type { RoutineMember } from "../utils/api";

export const routineMemberKey = (member: RoutineMember) => `${member.name}#${member.overload ?? ""}`;

export default function RoutineNavigator({ members, selected, onSelect, disabled = false }: {
  members: RoutineMember[]; selected: string; onSelect: (key: string) => void; disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState("ALL");
  const filtered = useMemo(() => {
    const terms = search.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return members.filter(member => {
      const text = `${member.name} ${member.overload ?? ""} ${member.returnType ?? ""} ${member.params.map(p => `${p.name} ${p.dataType} ${p.direction}`).join(" ")}`.toLocaleLowerCase();
      return (kind === "ALL" || member.kind === kind) && terms.every(term => text.includes(term));
    });
  }, [members, search, kind]);
  return <aside className="routine-navigator" aria-label="Callable routines">
    <div className="desktop-pane-heading"><FileCode2 size={14} /> Procedures &amp; Functions</div>
    <div className="routine-filters">
      <div className="routine-search"><Search size={13} /><input aria-label="Search procedures and functions" placeholder="Name, parameter, or type…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button type="button" aria-label="Clear routine search" onClick={() => setSearch("")}><X size={12} /></button>}</div>
      <select aria-label="Routine type" value={kind} onChange={event => setKind(event.target.value)}><option value="ALL">All routines</option><option value="PROCEDURE">Procedures</option><option value="FUNCTION">Functions</option></select>
      <div className="routine-match-count" role="status">{filtered.length} of {members.length} routines</div>
    </div>
    <div className="routine-member-list" role="group" aria-label="Matching routines">
      {filtered.map(member => <button type="button" key={routineMemberKey(member)} aria-pressed={selected === routineMemberKey(member)} disabled={disabled} onClick={() => onSelect(routineMemberKey(member))} title={`${member.name}(${member.params.map(p => `${p.name} ${p.direction} ${p.dataType}`).join(", ")})${member.returnType ? ` RETURN ${member.returnType}` : ""}`}>
        {member.kind === "FUNCTION" ? <FunctionSquare size={15} className="text-accenthi" /> : <FileCode2 size={15} className="text-ok" />}
        <span><strong>{member.name}</strong><small>{member.kind === "FUNCTION" ? `Function · ${member.returnType ?? "return value"}` : `Procedure · ${member.params.length} parameters`}{member.overload ? ` · overload ${member.overload}` : ""}</small><code>({member.params.map(p => `${p.name}: ${p.dataType}`).join(", ")})</code></span>
      </button>)}
      {!filtered.length && <div className="routine-no-matches"><strong>No matching routines</strong><p>Change the name or type filter. Your selected test is unchanged.</p><button type="button" onClick={() => { setSearch(""); setKind("ALL"); }}>Clear filters</button></div>}
    </div>
    <div className="routine-navigator-footer">Select a routine to edit its test inputs.</div>
  </aside>;
}
