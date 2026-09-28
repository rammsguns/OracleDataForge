import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { loadLayout, saveLayout, StudioProvider, useStudio } from "./state/store";
import Sidebar from "./components/Sidebar";
import Workspace from "./components/Workspace";
import Toasts from "./components/Toasts";
import { TitleBar, StatusBar } from "./components/Chrome";
import { ConfirmDialog, ConnectionWizard, ExportConnectionsDialog, ImportConnectionsDialog, ImportWizard } from "./components/Wizards";
import { download } from "./utils/sql";

const SIDEBAR_MIN = 200;
const SIDEBAR_MAX = 440;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function useHResize(
  initial: number,
  min: number,
  max: number,
  invert: boolean,
  onCommit: (size: number) => void
) {
  const [size, setSize] = useState(() => clamp(initial, min, max));
  // callbacks read the live values from refs, so dragging doesn't rebuild the listeners
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const apply = useCallback((n: number) => {
    sizeRef.current = n;
    setSize(n);
  }, []);

  const start = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startSize = sizeRef.current;
      const move = (ev: PointerEvent) => {
        const d = (ev.clientX - startX) * (invert ? -1 : 1);
        apply(clamp(startSize + d, min, max));
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        // persist once per drag rather than on every pointermove frame
        commitRef.current(sizeRef.current);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [min, max, invert, apply]
  );

  /** keyboard resize on the focused separator */
  const nudge = useCallback(
    (delta: number) => {
      const n = clamp(sizeRef.current + delta, min, max);
      apply(n);
      commitRef.current(n);
    },
    [min, max, apply]
  );

  return { size, start, nudge };
}

/** What a collapsed side panel leaves behind: a 32px strip that hands its width to the
 *  workspace but keeps the panel one click away — and visible, so nobody has to know
 *  the keyboard shortcut to get it back. */
function PanelRail({
  label,
  hint,
  onExpand,
}: {
  label: string;
  hint: string;
  onExpand: () => void;
}) {
  return (
    <button
      onClick={onExpand}
      title={`Show ${label.toLowerCase()} (${hint})`}
      aria-label={`Show ${label} panel`}
      aria-expanded={false}
      className="w-8 shrink-0 flex flex-col items-center gap-2.5 py-2 bg-panel text-mute hover:text-accenthi hover:bg-panel2 transition-colors border-r border-bdr"
    >
      <PanelLeftOpen size={15} />
      <span className="text-[10.5px] font-semibold uppercase tracking-wider [writing-mode:vertical-rl]">
        {label}
      </span>
    </button>
  );
}

function Shell() {
  const s = useStudio();
  const stored = useRef(loadLayout()).current;
  const sidebar = useHResize(stored.sidebarWidth, SIDEBAR_MIN, SIDEBAR_MAX, false, (w) =>
    saveLayout({ sidebarWidth: w })
  );
  const sRef = useRef(s);
  sRef.current = s;

  // global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = sRef.current;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      const inEditor = (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if (k === "b") {
        e.preventDefault();
        st.toggleSidebar();
      } else if (k === "s") {
        e.preventDefault();
        download("worksheet.sql", st.sql);
        st.toast("success", "Script saved as worksheet.sql");
      } else if (k === "t") {
        e.preventDefault();
        st.openTab("worksheet", `Worksheet ${Date.now() % 100}`, `ws-${Date.now()}`);
      } else if (k === "f" && e.shiftKey) {
        e.preventDefault();
        st.doFormat();
      } else if (k === "enter" && !inEditor) {
        e.preventDefault();
        st.runSql();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="h-full flex flex-col bg-bg text-ink">
      <TitleBar />
      <div className="flex-1 flex min-h-0">
        {s.sidebarOpen ? (
          <>
            <div style={{ width: sidebar.size }} className="shrink-0 max-md:!w-56">
              <Sidebar />
            </div>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize explorer"
              title="Drag to resize · double-click to collapse"
              tabIndex={0}
              onPointerDown={sidebar.start}
              onDoubleClick={s.toggleSidebar}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") sidebar.nudge(-16);
                if (e.key === "ArrowRight") sidebar.nudge(16);
              }}
              className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/50 transition-colors max-md:hidden"
            />
          </>
        ) : (
          <PanelRail label="Explorer" hint="Ctrl+B" onExpand={s.toggleSidebar} />
        )}
        <div className="flex-1 min-w-0">
          <Workspace />
        </div>
      </div>
      <StatusBar />
      <Toasts />
      {s.wizardOpen && <ConnectionWizard />}
      {s.importOpen && <ImportWizard />}
      {s.exportConnsOpen && <ExportConnectionsDialog />}
      {s.importConnsOpen && <ImportConnectionsDialog />}
      {/* last: the confirm dialog shares z-50 with the wizards, so it has to come after
          them in DOM order or an import/connection modal would paint over its own prompt */}
      <ConfirmDialog />
    </div>
  );
}

export default function App() {
  return (
    <StudioProvider>
      <Shell />
    </StudioProvider>
  );
}
