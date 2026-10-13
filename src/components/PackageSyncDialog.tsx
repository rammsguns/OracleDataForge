import { useEffect, useState } from 'react';
import { api } from '../utils/api';
import { missingPackageHeaders, syncPackageSpec, type PackageHeader } from '../utils/packageSync';
import { useStudio } from '../state/store';
import { Btn, Modal } from './ui';

export default function PackageSyncDialog({ connId, name, onClose, onDone }: {
  connId: string; name: string; onClose: () => void; onDone: () => void;
}) {
  const s = useStudio();
  const [source, setSource] = useState<{ spec: string; body: string } | null>(null);
  const [headers, setHeaders] = useState<PackageHeader[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const conn = s.connections.find(c => c.id === connId);
  const writable = conn?.status === 'connected' && !conn.readOnly && ['Administrator', 'Developer'].includes(s.accessRole);
  useEffect(() => {
    let cancelled = false;
    api.source(connId, name, 'PACKAGE').then(result => {
      if (cancelled) return;
      if (result.error || !result.source || !result.bodySource) throw new Error(result.error || 'A package specification and body are required.');
      const missing = missingPackageHeaders(result.source, result.bodySource);
      syncPackageSpec(result.source, []);
      setSource({ spec: result.source, body: result.bodySource });
      setHeaders(missing);
      setSelected(new Set(missing.map(h => h.key)));
    }).catch(e => { if (!cancelled) setError((e as Error).message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, [connId, name]);
  const sql = source ? syncPackageSpec(source.spec, headers.filter(h => selected.has(h.key))) : '';
  const apply = async (confirmed = false) => {
    if (busy || !source || !writable || !selected.size) return;
    setBusy(true); setError('');
    try {
      const current = await api.source(connId, name, 'PACKAGE');
      if (current.source !== source.spec || current.bodySource !== source.body) throw new Error('Package source changed. Close and reopen Sync Spec to review the latest source.');
      const result = await api.query(connId, sql, confirmed);
      if (result.confirmation) {
        s.askConfirm({ ...result.confirmation, title: `Sync specification for ${name}?`, onConfirm: () => { void apply(true); } });
        return;
      }
      if (result.error) throw new Error(result.error.message);
      // CREATE can succeed while Oracle leaves the package INVALID. Compile both
      // parts and read diagnostics before reporting success.
      const specResult = await api.compile(connId, name, 'PACKAGE', true);
      onDone();
      if (specResult.status !== 'VALID') {
        throw new Error('Specification saved but did not compile: ' + (specResult.errors.map(e => `Line ${e.line}: ${e.text}`).join('\n') || specResult.status));
      }
      const bodyResult = await api.compile(connId, name, 'PACKAGE BODY', true);
      onDone();
      if (bodyResult.status !== 'VALID') {
        throw new Error('Specification saved, but the body did not compile: ' + (bodyResult.errors.map(e => `Line ${e.line}: ${e.text}`).join('\n') || bodyResult.status));
      }
      s.toast('success', `${name} specification synced and package compiled`);
      onClose();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={`Package Sync — ${name}`} width={900} onClose={() => { if (!busy) onClose(); }}>
    <div className="space-y-4">
      <p className="text-[12px] text-mute">Sync Spec adds procedure and function declarations from the body. Missing headers are selected below. Uncheck any routines you want to keep private. Existing declarations and the body are preserved. Replacing the spec may invalidate dependent objects.</p>
      {busy && <p className="text-[12px] text-mute">Loading or applying package specification…</p>}
      {error && <p role="alert" className="text-[12px] text-err whitespace-pre-wrap">{error}</p>}
      {source && !headers.length && <p className="text-[12px]">The specification already contains all routine headers.</p>}
      {!!headers.length && <div className="flex gap-2 text-[12px]">
        <Btn variant="outline" disabled={busy} onClick={() => setSelected(new Set(headers.map(h => h.key)))}>Select all</Btn>
        <Btn variant="outline" disabled={busy} onClick={() => setSelected(new Set())}>Clear selection</Btn>
        <span className="text-mute self-center">{selected.size} of {headers.length} headers selected</span>
      </div>}
      <div className="max-h-48 overflow-auto space-y-2">{headers.map(h => <label key={h.key} className="flex gap-2 text-[12px] font-mono">
        <input type="checkbox" disabled={busy} checked={selected.has(h.key)} onChange={e => setSelected(prev => {
          const next = new Set(prev); if (e.target.checked) next.add(h.key); else next.delete(h.key); return next;
        })} /><span className="whitespace-pre-wrap">{h.declaration}</span>
      </label>)}</div>
      {!writable && <p className="text-[12px] text-err">Requires a connected, writable connection and Developer or Administrator access.</p>}
      {!!selected.size && <div><p className="text-[12px] text-mute mb-2">Updated specification</p><pre className="max-h-80 overflow-auto p-3 rounded border border-bdr bg-bg text-[12px] font-mono whitespace-pre-wrap">{sql}</pre></div>}
      <div className="flex justify-end gap-2"><Btn variant="outline" disabled={busy} onClick={onClose}>Close</Btn>
        <Btn variant="primary" disabled={busy || !writable || !selected.size} onClick={() => void apply()}>Sync Spec</Btn></div>
    </div>
  </Modal>;
}
