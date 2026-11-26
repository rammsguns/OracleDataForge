import { useMemo, useState } from 'react';
import type { PackageInstallPlan } from '../utils/packageInstall';
import { downloadSqlZip, packageInsertFiles, type InsertScriptOutput } from '../utils/installScriptExport';
import { Btn, inputCls } from './ui';

export default function PackageInsertExport({plan, onError}: {plan: PackageInstallPlan; onError: (message: string) => void}) {
  const [output, setOutput] = useState<InsertScriptOutput>('single');
  const [filename, setFilename] = useState('inserts.sql');
  const files = useMemo(() => packageInsertFiles(plan, output), [plan, output]);
  const current = files.find(f => f.name === filename) ?? files[0];
  const download = () => {
    try {
      if (output === 'per-table') downloadSqlZip(files, 'package-inserts-by-table.zip');
      else {
        const url = URL.createObjectURL(new Blob([files[0].content], {type: 'text/plain'}));
        const a = document.createElement('a'); a.href = url; a.download = 'inserts.sql'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  };
  if (!files.length) return null;
  return <section aria-label="INSERT script export" className="space-y-2 border border-bdr rounded p-3">
    <h4 className="font-semibold">Separate INSERT export ({plan.exports.length} tables)</h4>
    <p className="text-mute">Run the object install script first. INSERT files include the required identity handling and validation.</p>
    <label className="flex items-center gap-2">INSERT script output
      <select aria-label="INSERT script output" className={inputCls} value={output} onChange={e => setOutput(e.target.value as InsertScriptOutput)}>
        <option value="single">All tables in one INSERT script</option>
        <option value="per-table">One INSERT script per table (ZIP)</option>
      </select>
    </label>
    {output === 'per-table' && <p className="text-warn">[WARNING] Each table file explicitly commits its rows. Run run_inserts.sql to follow the planner order. Earlier tables remain committed if a later table fails.</p>}
    <Btn variant="outline" onClick={download}>{output === 'single' ? 'Download inserts.sql' : 'Download INSERT scripts by table (ZIP)'}</Btn>
    {output === 'per-table' && <label className="flex items-center gap-2">Preview INSERT file
      <select aria-label="Preview INSERT file" className={inputCls} value={current?.name} onChange={e => setFilename(e.target.value)}>
        {files.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
      </select>
    </label>}
    <pre aria-label="INSERT script" className="max-h-96 overflow-auto p-3 bg-panel2 border border-bdr rounded text-[11px] whitespace-pre">{current?.content}</pre>
  </section>;
}
