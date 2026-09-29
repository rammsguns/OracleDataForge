import { useEffect, useState } from "react";
import { api } from "../utils/api";
import { Btn, Field, Modal, Spinner, inputCls } from "./ui";
import PackageExport from "./PackageExport";

export default function SavePackageDialog({ connId, onClose }: { connId: string; onClose: () => void }) {
  const [packages, setPackages] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [source, setSource] = useState<{ object: string; spec: string; body: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    api.schemaGroup(connId, "Packages").then((group) => {
      if (!alive) return;
      setPackages(group.items);
      setSelected(group.items[0] ?? "");
    }).catch((e: Error) => { if (alive) setError(e.message); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [connId]);
  const next = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api.source(connId, selected);
      if (result.error || !result.source || result.type !== "PACKAGE") throw new Error(result.error || "The package has no readable specification.");
      setSource({ object: selected, spec: result.source, body: result.bodySource ?? null });
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  if (source) return <PackageExport {...source} sourceDescription="saved database source" onClose={onClose} />;
  return <Modal title="Save package code" onClose={onClose} width={480}>
    <div className="space-y-4">
      {loading ? <Spinner label="Loading packages…" /> : packages.length ? (
        <Field label="Package"><select className={inputCls} value={selected} disabled={busy} onChange={(e) => setSelected(e.target.value)}>
          {packages.map((name) => <option key={name} value={name}>{name}</option>)}
        </select></Field>
      ) : !error && <p className="text-[12px] text-mute">No packages were found in this connection.</p>}
      {error && <p role="alert" className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2"><Btn variant="outline" onClick={onClose}>Cancel</Btn>
        <Btn variant="primary" disabled={loading || busy || !selected} onClick={() => void next()}>{busy ? "Loading source…" : "Next"}</Btn>
      </div>
    </div>
  </Modal>;
}
