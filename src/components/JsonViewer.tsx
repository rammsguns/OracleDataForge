import { useMemo, useState } from "react";
import { Copy, Download } from "lucide-react";
import { download } from "../utils/sql";
import { copyText } from "../utils/clipboard";
import { useStudio } from "../state/store";
import { Btn, Modal } from "./ui";

export default function JsonViewer({ column, value, onClose }: { column: string; value: string; onClose: () => void }) {
  const studio = useStudio();
  const [raw, setRaw] = useState(false);
  const parsed = useMemo(() => {
    try {
      return { formatted: JSON.stringify(JSON.parse(value), null, 2), error: "" };
    } catch (error) {
      return { formatted: value, error: error instanceof Error ? error.message : "Could not parse this value." };
    }
  }, [value]);
  const displayed = raw ? value : parsed.formatted;

  return <Modal title={`JSON viewer — ${column}`} onClose={onClose} width={900}>
    <div className="flex flex-col gap-3 min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <Btn variant="outline" onClick={() => setRaw(!raw)} disabled={!!parsed.error}>{raw ? "Show formatted" : "Show original"}</Btn>
        <Btn variant="outline" onClick={() => download(`${column.replace(/[^a-z0-9_-]/gi, "_")}.json`, displayed, "application/json")}><Download size={12} /> Download</Btn>
        <Btn variant="outline" title="Copy the displayed JSON" onClick={async () => {
          try {
            await copyText(displayed);
            studio.toast("success", "JSON copied to clipboard");
          } catch (error) {
            studio.toast("error", error instanceof Error ? error.message : "Could not copy JSON to clipboard.");
          }
        }}><Copy size={12} /> Copy</Btn>
      </div>
      {parsed.error && <p role="alert" className="text-[12px] text-warn">Invalid JSON: {parsed.error} The original value is shown below.</p>}
      <pre tabIndex={0} aria-label={`${column} JSON content`} className="max-h-[60vh] overflow-auto bg-panel2 border border-bdr rounded-lg p-4 text-[12px] font-mono whitespace-pre text-ink">{displayed}</pre>
    </div>
  </Modal>;
}
