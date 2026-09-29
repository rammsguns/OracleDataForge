import { useState } from "react";
import { Download } from "lucide-react";
import { useStudio } from "../state/store";
import { download } from "../utils/sql";
import { Btn, Field, Modal, inputCls } from "./ui";

export default function PackageExport({ object, spec, body, dirty = false, sourceDescription = "current editor contents", onClose }: {
  object: string; spec: string; body: string | null; dirty?: boolean; sourceDescription?: string; onClose: () => void;
}) {
  const { toast } = useStudio();
  const [exportLayout, setExportLayout] = useState<"combined" | "separate">("combined");
  const hasBody = body != null;
  return (
        <Modal title="Export package" onClose={() => onClose()} width={480}>
          <div className="space-y-4">
            <p className="text-[12px] text-soft">Export the {sourceDescription}{dirty ? ", including unsaved changes" : ""}. The specification comes before the body in a combined file.</p>
            <Field label="Files">
              <select className={inputCls} value={exportLayout} onChange={(e) => setExportLayout(e.target.value as "combined" | "separate")}>
                <option value="combined">One SQL file — specification and body</option>
                <option value="separate">Separate files — specification (.pks) and body (.pkb)</option>
              </select>
            </Field>
            {!hasBody && <p className="text-[12px] text-mute">This package has no body. Only the specification will be exported.</p>}
            <div className="flex justify-end gap-2">
              <Btn variant="outline" onClick={() => onClose()}>Cancel</Btn>
              <Btn variant="primary" disabled={!spec.trim() || (hasBody && !body?.trim())} onClick={() => {
                const script = (source: string) => `${source.trimEnd().replace(/(?:\r?\n)[ \t]*\/[ \t]*$/, "")}\n/\n`;
                const filename = object.replace(/[^a-zA-Z0-9_$#.-]/g, "_");
                if (exportLayout === "combined") {
                  download(`${filename}.sql`, script(spec) + (hasBody ? `\n${script(body ?? "")}` : ""));
                } else {
                  download(`${filename}.pks`, script(spec));
                  if (hasBody) download(`${filename}.pkb`, script(body ?? ""));
                }
                onClose();
                toast("success", `${object} exported${exportLayout === "separate" && hasBody ? " as specification and body files" : " as one SQL file"}`);
              }}><Download size={13} /> Export</Btn>
            </div>
          </div>
        </Modal>
  );
}
