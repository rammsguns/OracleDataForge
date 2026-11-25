import type { DeploymentTablespaces } from '../utils/schemaCompare';
import { inputCls } from './ui';

export default function DeploymentTablespaceFields({ value, onChange }: {value: DeploymentTablespaces; onChange: (value: DeploymentTablespaces) => void}) {
  return <div className="space-y-2">
    <div className="flex gap-4 flex-wrap">
      <label className="flex gap-2 items-center">Table / materialized-view tablespace
        <input aria-label="Table tablespace" className={inputCls} placeholder="Target default / source setting" value={value.tableTablespace ?? ''} onChange={e => onChange({...value, tableTablespace: e.target.value})} />
      </label>
      <label className="flex gap-2 items-center">Index tablespace
        <input aria-label="Index tablespace" className={inputCls} placeholder="Target default / source setting" value={value.indexTablespace ?? ''} onChange={e => onChange({...value, indexTablespace: e.target.value})} />
      </label>
    </div>
    <p className="text-mute">Applies to newly created segments, including key indexes, partitions and LOB storage. Blank keeps current default/storage behavior. Existing objects are not moved. Names must exist on the target; quote case-sensitive names.</p>
  </div>;
}
