import { Keyboard, Moon, PanelLeft, ShieldCheck, Sun } from "lucide-react";
import { useState } from "react";
import { schemaOf, useStudio } from "../state/store";
import { api } from "../utils/api";
import { Btn, Field, Modal, inputCls } from "./ui";

/**
 * Change your own password — the one account action that is not Administrator-only, so a
 * Developer, Analyst or Viewer is not stuck asking someone else to rotate their credential.
 *
 * Authentication is HTTP Basic: there is no server session to re-issue, so once the stored
 * password changes the browser keeps replaying the old one and every request 401s. The
 * dialog ends by saying so instead of leaving the app to fail on its next call.
 */
function ChangePassword({ onClose }: { onClose: () => void }) {
  const s = useStudio();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError(null);
    if (next.length < 8) return setError("The new password must be at least 8 characters.");
    if (next !== repeat) return setError("The two new-password entries do not match.");
    setBusy(true);
    try {
      await api.changeOwnPassword(current, next);
      setDone(true);
      s.toast("success", "Password changed — sign in again with the new one");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="text-[12.5px] text-soft space-y-2">
        <p className="text-ok font-semibold">Your password has been changed.</p>
        <p>
          This app signs in over HTTP Basic, so your browser is still sending the old password and the next
          request it makes will fail. Close this window and sign in again with the new one — a private window
          is the quickest way to get a fresh prompt.
        </p>
        <div className="pt-1">
          <Btn variant="primary" onClick={onClose}>
            Done
          </Btn>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <Field label="Current password">
        <input type="password" className={inputCls} value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
      </Field>
      <Field label="New password" hint="At least 8 characters.">
        <input type="password" className={inputCls} value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" />
      </Field>
      <Field label="Repeat new password">
        <input type="password" className={inputCls} value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" />
      </Field>
      {error && <div className="text-[12px] text-err">{error}</div>}
      <div className="flex justify-end gap-2 pt-1">
        <Btn variant="outline" onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={() => void submit()} disabled={busy || !current || !next}>
          {busy ? "Changing…" : "Change password"}
        </Btn>
      </div>
    </div>
  );
}

export function TitleBar() {
  const s = useStudio();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const conn = s.connections.find((c) => c.id === s.activeConnId);

  return (
    <header className="h-11 flex items-center gap-2 px-3 border-b border-bdr bg-panel shrink-0">
      {/* brand */}
      <div className="flex items-center gap-2 mr-2">
        <div className="w-6.5 h-6.5 rounded-lg bg-gradient-to-br from-[var(--accent)] to-[#8b5cf6] flex items-center justify-center shadow-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M5 7c0-1.7 3.1-3 7-3s7 1.3 7 3v10c0 1.7-3.1 3-7 3s-7-1.3-7-3V7z" stroke="white" strokeWidth="2" />
            <ellipse cx="12" cy="7" rx="7" ry="3" fill="white" />
          </svg>
        </div>
        <span className="text-[13.5px] font-bold tracking-tight">
          Oracle <span className="text-accenthi font-semibold">DataForge</span>
        </span>
      </div>

      <button
        type="button"
        onClick={s.toggleSidebar}
        className={`p-1.5 rounded-md transition-colors ${s.sidebarOpen ? "text-accenthi bg-accentdim" : "text-mute hover:text-soft hover:bg-panel3"}`}
        title="Toggle explorer (Ctrl+B)"
        aria-label="Toggle explorer panel"
        aria-pressed={s.sidebarOpen}
      >
        <PanelLeft size={15} />
      </button>

      {/* active connection pill */}
      {conn && (
        <div className="hidden sm:flex items-center gap-2 border border-bdr rounded-full pl-2 pr-3 h-7 text-[11.5px]" title={`${conn.host}:${conn.port} as ${conn.user}`}>
          <span className={`w-2 h-2 rounded-full ${conn.status === "connected" ? "bg-ok shadow-[0_0_6px_var(--ok)]" : conn.status === "error" ? "bg-err" : "bg-mute"}`} />
          <span className="font-medium text-soft">{conn.name}</span>
          <span className="text-mute uppercase text-[10px]">Oracle</span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => setAccountOpen(true)}
          className="hidden md:flex items-center gap-1.5 h-7 px-2 rounded-md border border-bdr text-[10.5px] text-mute hover:text-soft hover:border-accent/60 hover:bg-accentdim transition-colors"
          title={s.session?.name ? `Signed in as ${s.session.name} — open account settings` : "Server-enforced access role for this session"}
        >
          <ShieldCheck size={13} className="text-accenthi" />
          <span className="text-soft font-medium">{s.accessRole}</span>
        </button>
        <button
          type="button"
          onClick={() => setShortcutsOpen(true)}
          className="p-1.5 rounded-md text-mute hover:text-soft hover:bg-panel3 transition-colors"
          title="Keyboard shortcuts (Ctrl+/)"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={15} />
        </button>
        <button
          type="button"
          onClick={s.toggleTheme}
          className="p-1.5 rounded-md text-mute hover:text-soft hover:bg-panel3 transition-colors"
          title={`Switch to ${s.theme === "dark" ? "light" : "dark"} mode`}
          aria-label="Toggle color theme"
        >
          {s.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

      {accountOpen && (
        <Modal title="Account" onClose={() => setAccountOpen(false)} width={440}>
          <div className="mb-4 text-[12.5px] text-soft space-y-0.5">
            <div>
              <span className="text-mute">Signed in as</span> <span className="font-medium text-ink">{s.session?.name ?? "—"}</span>
            </div>
            {s.session?.email && <div className="font-mono text-[12px] text-mute">{s.session.email}</div>}
            <div>
              <span className="text-mute">Role</span> <span className="font-medium text-ink">{s.accessRole}</span>
            </div>
          </div>
          {/* three states, and they are not interchangeable: no session at all means the server
              never authenticated this browser (the role chip is showing its Viewer fallback,
              not a real role), while a session with no email is the break-glass token or a
              workspace that has no accounts yet — neither has a stored password to rotate */}
          {!s.session ? (
            <div className="text-[12.5px] text-mute">
              This browser is not signed in — the server did not authenticate it, so the role above is a
              fallback rather than a role you hold. Reload the page and sign in, then reopen this dialog.
            </div>
          ) : s.session.email ? (
            <ChangePassword onClose={() => setAccountOpen(false)} />
          ) : (
            <div className="text-[12.5px] text-mute">
              {s.session.accountsConfigured
                ? "You are signed in with the break-glass token, which has no stored account. Sign in as a workspace account to change its password."
                : "This workspace has no accounts yet, so there is no password to change. Create one in Administration first."}
            </div>
          )}
        </Modal>
      )}

      {shortcutsOpen && (
        <Modal title="Keyboard shortcuts" onClose={() => setShortcutsOpen(false)} width={420}>
          <table className="w-full text-[12.5px]">
            <tbody>
              {[
                ["Run statement", "Ctrl + Enter"],
                ["Format SQL", "Ctrl + Shift + F"],
                ["Save script", "Ctrl + S"],
                ["New worksheet", "Ctrl + T"],
                ["Toggle explorer", "Ctrl + B"],
                ["Accept autocomplete", "Tab / Enter"],
                ["Close dialog / menu", "Esc"],
              ].map(([what, keys]) => (
                <tr key={what} className="border-b border-bdrsoft last:border-0">
                  <td className="py-2 text-soft">{what}</td>
                  <td className="py-2 text-right">
                    {keys.split(" + ").map((k, i) => (
                      <span key={i}>
                        {i > 0 && <span className="text-mute mx-1">+</span>}
                        <kbd>{k}</kbd>
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Modal>
      )}
    </header>
  );
}

const CONN_LABEL: Record<string, string> = {
  connected: "Connected",
  idle: "Not connected",
  error: "Connection failed",
};

export function StatusBar() {
  const s = useStudio();
  const conn = s.connections.find((c) => c.id === s.activeConnId);
  const schema = schemaOf(conn);
  return (
    <footer className="h-6 flex items-center gap-4 px-3 border-t border-bdr bg-panel text-[11px] text-mute shrink-0">
      <span className="flex items-center gap-1.5">
        <span
          className={`w-1.5 h-1.5 rounded-full ${
            conn?.status === "connected" ? "bg-ok" : conn?.status === "error" ? "bg-err" : "bg-mute"
          }`}
        />
        {conn ? `${CONN_LABEL[conn.status] ?? conn.status} · ${conn.name}` : "No connection"}
      </span>
      {schema && <span className="hidden md:inline">Schema: {schema}</span>}
      {s.result && !s.result.error && (
        <span className="hidden md:inline tabular-nums">
          Last run: {s.result.rowsReturned} rows / {s.result.durationMs} ms
        </span>
      )}
      {/* the backend runs every statement with autoCommit: true — don't claim otherwise */}
      <span className="ml-auto hidden sm:inline">UTF-8 · Autocommit on</span>
      <span className="tabular-nums">Ln {s.sql.split("\n").length}</span>
    </footer>
  );
}
