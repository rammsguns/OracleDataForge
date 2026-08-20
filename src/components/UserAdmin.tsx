import { useMemo, useState } from "react";
import {
  Activity,
  BadgeCheck,
  Clock3,
  Pencil,
  Plus,
  Search,
  Shield,
  ShieldCheck,
  Trash2,
  UserMinus,
  UserRoundCheck,
  Users,
} from "lucide-react";
import { useStudio } from "../state/store";
import { Badge, Btn, Field, Modal, inputCls } from "./ui";

type Role = "Administrator" | "Developer" | "Analyst" | "Viewer";
type UserStatus = "Active" | "Suspended";
type AdminUser = { id: string; name: string; email: string; role: Role; status: UserStatus; lastActive: string; mfa: boolean };
type Audit = { id: string; at: string; actor: string; action: string; subject: string };

const STORAGE = "dataforge-admin-users";
const AUDIT_STORAGE = "dataforge-admin-audit";
const ROLES: Role[] = ["Administrator", "Developer", "Analyst", "Viewer"];

function read<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) ?? "") as T; } catch { return fallback; }
}

const roleTone = (role: Role): "accent" | "ok" | "warn" | "neutral" =>
  role === "Administrator" ? "accent" : role === "Developer" ? "ok" : role === "Analyst" ? "warn" : "neutral";

function UserForm({ user, onSave, onClose }: { user?: AdminUser; onSave: (v: Omit<AdminUser, "id" | "lastActive">) => void; onClose: () => void }) {
  const [name, setName] = useState(user?.name ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [role, setRole] = useState<Role>(user?.role ?? "Viewer");
  const [mfa, setMfa] = useState(user?.mfa ?? true);
  const [error, setError] = useState("");
  const submit = () => {
    if (!name.trim() || !/^\S+@\S+\.\S+$/.test(email)) return setError("Enter a name and a valid email address.");
    onSave({ name: name.trim(), email: email.trim().toLowerCase(), role, mfa, status: user?.status ?? "Active" });
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : "Add Dataforge user"} onClose={onClose} width={480}>
      <div className="space-y-3.5">
        <Field label="Full name"><input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Taylor Morgan" /></Field>
        <Field label="Email address"><input className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="taylor@company.com" /></Field>
        <Field label="Role">
          <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value as Role)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        </Field>
        <label className="flex items-center gap-2.5 rounded-lg border border-bdrsoft bg-panel2/50 px-3 py-2.5 cursor-pointer">
          <input type="checkbox" checked={mfa} onChange={(e) => setMfa(e.target.checked)} className="accent-[var(--accent)]" />
          <span className="text-[12px] text-soft"><span className="font-medium text-ink">Require multi-factor authentication</span><br />Prompt this user for MFA at next sign-in.</span>
        </label>
        {error && <p className="text-[11.5px] text-err">{error}</p>}
        <div className="flex justify-end gap-2 pt-1"><Btn variant="outline" onClick={onClose}>Cancel</Btn><Btn variant="primary" onClick={submit}>{user ? "Save changes" : "Send invite"}</Btn></div>
      </div>
    </Modal>
  );
}

export default function UserAdmin() {
  const s = useStudio();
  const [users, setUsers] = useState<AdminUser[]>(() => read<AdminUser[]>(STORAGE, []).map((u) =>
    (u as unknown as { role: string }).role === "Owner" ? { ...u, role: "Administrator" } : u
  ));
  const [audit, setAudit] = useState<Audit[]>(() => read(AUDIT_STORAGE, []));
  const [query, setQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"All" | Role>("All");
  const [view, setView] = useState<"users" | "audit">("users");
  const [formUser, setFormUser] = useState<AdminUser | undefined | null>(null);
  const persist = (next: AdminUser[]) => { setUsers(next); localStorage.setItem(STORAGE, JSON.stringify(next)); };
  const log = (action: string, subject: string) => {
    const next = [{ id: `${Date.now()}`, at: new Date().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }), actor: "You", action, subject }, ...audit].slice(0, 100);
    setAudit(next); localStorage.setItem(AUDIT_STORAGE, JSON.stringify(next));
  };
  const save = (value: Omit<AdminUser, "id" | "lastActive">) => {
    if (formUser) { persist(users.map((u) => u.id === formUser.id ? { ...u, ...value } : u)); log("Updated user", value.name); s.toast("success", `${value.name}'s access updated`); }
    else { const user = { ...value, id: `u-${Date.now()}`, lastActive: "Invitation pending" }; persist([...users, user]); log("Invited user", user.name); s.toast("success", `Invite sent to ${user.email}`); }
    setFormUser(null);
  };
  const changeStatus = (user: AdminUser) => {
    const nextStatus: UserStatus = user.status === "Active" ? "Suspended" : "Active";
    s.askConfirm({ title: `${nextStatus === "Suspended" ? "Suspend" : "Restore"} ${user.name}?`, body: nextStatus === "Suspended" ? "They will immediately lose access to Dataforge. Their activity history and role will be retained." : "They will regain access with their existing role.", confirmLabel: nextStatus === "Suspended" ? "Suspend user" : "Restore user", danger: nextStatus === "Suspended", onConfirm: () => { persist(users.map((u) => u.id === user.id ? { ...u, status: nextStatus } : u)); log(nextStatus === "Suspended" ? "Suspended user" : "Restored user", user.name); s.toast("info", `${user.name} ${nextStatus.toLowerCase()}`); } });
  };
  const remove = (user: AdminUser) => s.askConfirm({ title: `Remove ${user.name}?`, body: "This permanently removes the user from Dataforge. This action cannot be undone.", confirmLabel: "Remove user", danger: true, onConfirm: () => { persist(users.filter((u) => u.id !== user.id)); log("Removed user", user.name); s.toast("info", `${user.name} removed`); } });
  const filtered = useMemo(() => users.filter((u) => (roleFilter === "All" || u.role === roleFilter) && `${u.name} ${u.email}`.toLowerCase().includes(query.toLowerCase())), [users, query, roleFilter]);
  const activeCount = users.filter((u) => u.status === "Active").length;
  return <div className="h-full overflow-y-auto p-4 space-y-4 df-fade">
    <div className="flex flex-wrap items-center gap-2.5">
      <div className="w-8 h-8 rounded-lg bg-accentdim text-accenthi grid place-items-center"><ShieldCheck size={17} /></div>
      <div><h2 className="text-[14px] font-semibold">Admin</h2><p className="text-[11.5px] text-mute">Manage Dataforge workspace access, roles, and security.</p></div>
      <div className="ml-auto"><Btn variant="primary" onClick={() => setFormUser(undefined)}><Plus size={14} /> Add user</Btn></div>
    </div>
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      <Stat icon={<Users size={15} />} label="Workspace users" value={String(users.length)} detail={`${activeCount} active`} />
      <Stat icon={<UserRoundCheck size={15} />} label="Administrators" value={String(users.filter((u) => u.role === "Administrator").length)} detail="privileged users" />
      <Stat icon={<Shield size={15} />} label="MFA coverage" value={`${users.length ? Math.round(users.filter((u) => u.mfa).length / users.length * 100) : 0}%`} detail="enrolled users" />
      <Stat icon={<UserMinus size={15} />} label="Suspended" value={String(users.filter((u) => u.status === "Suspended").length)} detail="access blocked" />
    </div>
    <section className="border border-bdr rounded-xl bg-panel overflow-hidden">
      <div className="px-4 pt-3 border-b border-bdrsoft flex flex-wrap items-center gap-3">
        <div className="flex gap-4 self-stretch"><button className={`text-[12px] font-medium border-b-2 ${view === "users" ? "border-accent text-ink" : "border-transparent text-mute"}`} onClick={() => setView("users")}>Users</button><button className={`text-[12px] font-medium border-b-2 ${view === "audit" ? "border-accent text-ink" : "border-transparent text-mute"}`} onClick={() => setView("audit")}>Audit log {audit.length > 0 && <span className="text-mute">({audit.length})</span>}</button></div>
        {view === "users" && <div className="ml-auto flex gap-2 pb-2.5"><div className="relative"><Search size={13} className="absolute left-2.5 top-2 text-mute" /><input className="h-7 w-52 pl-7 pr-2 rounded-md bg-panel2 border border-bdr text-[11.5px] focus:outline-none focus:border-accent" placeholder="Search users" value={query} onChange={(e) => setQuery(e.target.value)} /></div><select aria-label="Filter by role" className="h-7 rounded-md bg-panel2 border border-bdr px-2 text-[11.5px]" value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as "All" | Role)}><option>All</option>{ROLES.map((r) => <option key={r}>{r}</option>)}</select></div>}
      </div>
      {view === "users" ? <div className="overflow-x-auto"><table className="w-full text-left"><thead className="bg-panel2/60 text-[10.5px] uppercase tracking-wider text-mute"><tr><th className="px-4 py-2.5 font-semibold">User</th><th className="px-3 py-2.5 font-semibold">Role</th><th className="px-3 py-2.5 font-semibold">Security</th><th className="px-3 py-2.5 font-semibold">Last active</th><th className="px-3 py-2.5 font-semibold">Status</th><th className="px-4 py-2.5" /></tr></thead><tbody>{filtered.map((u) => <tr key={u.id} className="border-t border-bdrsoft hover:bg-panel2/35"><td className="px-4 py-3"><div className="flex items-center gap-2.5"><div className="w-7 h-7 rounded-full bg-accentdim text-accenthi grid place-items-center text-[10px] font-bold">{u.name.split(" ").map((n) => n[0]).join("").slice(0, 2)}</div><div><div className="text-[12.5px] font-medium">{u.name}</div><div className="text-[11px] text-mute">{u.email}</div></div></div></td><td className="px-3 py-3"><Badge tone={roleTone(u.role)}>{u.role}</Badge></td><td className="px-3 py-3">{u.mfa ? <span className="inline-flex items-center gap-1 text-[11px] text-ok"><BadgeCheck size={13} /> MFA enabled</span> : <span className="text-[11px] text-warn">MFA not enrolled</span>}</td><td className="px-3 py-3 text-[11.5px] text-soft whitespace-nowrap">{u.lastActive}</td><td className="px-3 py-3"><Badge tone={u.status === "Active" ? "ok" : "err"}>{u.status}</Badge></td><td className="px-4 py-3"><div className="flex justify-end gap-1"><Btn title="Edit user" onClick={() => setFormUser(u)}><Pencil size={13} /></Btn><Btn title={u.status === "Active" ? "Suspend user" : "Restore user"} onClick={() => changeStatus(u)}>{u.status === "Active" ? <UserMinus size={13} /> : <UserRoundCheck size={13} />}</Btn><Btn title="Remove user" variant="ghost" onClick={() => remove(u)} className="hover:!text-err"><Trash2 size={13} /></Btn></div></td></tr>)}</tbody></table>{filtered.length === 0 && <div className="py-12 text-center text-[12px] text-mute">No users match this filter.</div>}</div> : <div className="divide-y divide-bdrsoft">{audit.length ? audit.map((item) => <div key={item.id} className="px-4 py-3 flex gap-3 items-center"><div className="w-7 h-7 shrink-0 rounded-full bg-panel2 text-accenthi grid place-items-center"><Activity size={13} /></div><div className="text-[12px]"><span className="font-medium">{item.actor}</span> <span className="text-soft">{item.action.toLowerCase()}</span> <span className="font-medium">{item.subject}</span></div><time className="ml-auto text-[11px] text-mute whitespace-nowrap">{item.at}</time></div>) : <div className="py-14 text-center text-[12px] text-mute"><Clock3 size={18} className="mx-auto mb-2" />Administrative actions will appear here.</div>}</div>}
    </section>
    {formUser !== null && <UserForm user={formUser} onSave={save} onClose={() => setFormUser(null)} />}
  </div>;
}

function Stat({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string; detail: string }) {
  return <div className="border border-bdr rounded-xl bg-panel p-3.5"><div className="flex items-center gap-1.5 text-[10.5px] uppercase tracking-wider font-semibold text-mute"><span className="text-accenthi">{icon}</span>{label}</div><div className="mt-1.5 text-[22px] font-bold leading-none">{value}</div><div className="mt-1 text-[11px] text-mute">{detail}</div></div>;
}
