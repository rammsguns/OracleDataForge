import { Keyboard, Moon, PanelLeft, Sun } from "lucide-react";
import { useState } from "react";
import { ENGINE_LABEL } from "../data/catalog";
import { schemaOf, useStudio } from "../state/store";
import { Modal } from "./ui";

export function TitleBar() {
  const s = useStudio();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
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
          <span className="text-mute uppercase text-[10px]">{ENGINE_LABEL[conn.engine]}</span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-1">
        <button
          onClick={() => setShortcutsOpen(true)}
          className="p-1.5 rounded-md text-mute hover:text-soft hover:bg-panel3 transition-colors"
          title="Keyboard shortcuts (Ctrl+/)"
          aria-label="Keyboard shortcuts"
        >
          <Keyboard size={15} />
        </button>
        <button
          onClick={s.toggleTheme}
          className="p-1.5 rounded-md text-mute hover:text-soft hover:bg-panel3 transition-colors"
          title={`Switch to ${s.theme === "dark" ? "light" : "dark"} mode`}
          aria-label="Toggle color theme"
        >
          {s.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>

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
