import { useRef, useState, type ReactNode } from "react";
import { Database, PlugZap } from "lucide-react";
import { useStudio } from "../state/store";
import ConnectionPicker from "./ConnectionPicker";
import { Btn, Spinner } from "./ui";

/** Open the tool first, and defer mounting database readers until a connection is ready. */
export default function ToolConnectionGate({ title, children }: { title: string; children: ReactNode }) {
  const s = useStudio();
  const connections = s.connections.filter(connection => connection.live && connection.engine === "oracle");
  const active = connections.find(connection => connection.id === s.activeConnId);
  const [selectedId, setSelectedId] = useState(active?.id ?? "");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const openedConnection = useRef<string | null>(null);
  const selected = connections.find(connection => connection.id === selectedId);

  const open = async () => {
    if (!selected || busy.current) return;
    if (selected.status === "connected") { s.setActiveConnId(selected.id); return; }
    busy.current = true;
    setConnecting(true); setError("");
    try { await s.reconnectConn(selected.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { busy.current = false; setConnecting(false); }
  };

  if (active?.status === "connected") openedConnection.current = active.id;
  // Once mounted, the tool owns its error/reconnect view. A transient disconnect must
  // not discard its filters, inputs, or an in-progress operation's outcome.
  if (active && openedConnection.current === active.id) return <>{children}</>;

  return <div className="h-full overflow-auto bg-panel p-4 sm:p-6">
    <section className="mx-auto max-w-xl space-y-4" aria-label={`${title} connection selection`}>
      <div className="flex items-start gap-3 border-b border-bdr pb-4">
        <Database size={22} className="text-accenthi shrink-0 mt-1" />
        <div><h2 className="font-semibold text-[15px]">Choose a connection for {title}</h2>
          <p className="text-[12px] text-mute mt-1">Search your saved Oracle connections, then open the tool with the database you choose.</p></div>
      </div>
      {connections.length ? <>
        <ConnectionPicker label="Tool" connections={connections} value={selected?.id ?? ""} disabled={connecting} defaultOpen inlineOptions onChange={id => { setSelectedId(id); setError(""); }} />
        {(error || selected?.lastError) && <p role="alert" className="text-[12px] text-err break-words">{error || selected?.lastError}</p>}
        <div className="flex items-center justify-end gap-2">
          <Btn variant="primary" disabled={!selected || connecting} onClick={() => void open()}>
            {connecting ? <Spinner label="Connecting…" /> : <><PlugZap size={13} />{selected?.status === "connected" ? "Open tool" : "Connect and open"}</>}
          </Btn>
        </div>
      </> : <div className="border border-bdr p-4 space-y-3 text-[12px]">
        <p className="text-soft">No saved Oracle connections available.</p>
        {(s.accessRole === "Administrator" || s.accessRole === "Developer") && <Btn variant="outline" onClick={() => { s.setEditingConn(null); s.setWizardOpen(true); }}>New connection</Btn>}
      </div>}
    </section>
  </div>;
}
