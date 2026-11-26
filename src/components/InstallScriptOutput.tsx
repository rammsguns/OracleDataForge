import type { InstallScriptOutput, SqlExportFile } from '../utils/installScriptExport';
import { inputCls } from './ui';

export function InstallScriptOutputSelector({value, onChange}: {value: InstallScriptOutput; onChange: (value: InstallScriptOutput) => void}) {
  return <label className="flex gap-2 items-center">Install script output
    <select aria-label="Install script output" className={inputCls} value={value} onChange={e => onChange(e.target.value as InstallScriptOutput)}>
      <option value="single">One install script</option>
      <option value="by-type">One script per object type (ZIP)</option>
    </select>
  </label>;
}
export function InstallScriptFileSelector({files, value, onChange}: {files: SqlExportFile[]; value: string; onChange: (value: string) => void}) {
  return <div className="space-y-2">
    <p className="text-mute">The ZIP includes the full install.sql in its original order and separate type files. Run the master or selected files after their prerequisites; do not run both.</p>
    <label className="flex gap-2 items-center">Preview archive file
      <select aria-label="Preview archive file" className={inputCls} value={value} onChange={e => onChange(e.target.value)}>
        {files.map(file => <option key={file.name} value={file.name}>{file.name}</option>)}
      </select>
    </label>
  </div>;
}
