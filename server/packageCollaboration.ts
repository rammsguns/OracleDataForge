/** Presence is advisory; source comparison and serialized saves prevent stale editor writes. */
export class PackageCollaboration {
  private viewers = new Map<string, Map<string, { owner: string; name: string; editing: boolean; part: string; touched: number }>>();
  private busy = new Set<string>();
  constructor(private ttl = 90_000) {}

  heartbeat(key: string, id: string, owner: string, name: string, editing: boolean, part: string, now = Date.now()) {
    this.expire(now);
    let entries = this.viewers.get(key);
    if (!entries) { entries = new Map(); this.viewers.set(key, entries); }
    const previous = entries.get(id);
    if (previous && previous.owner !== owner) throw new Error('Editor belongs to another user. Reopen this tab.');
    if (!previous && [...this.viewers.values()].reduce((n, v) => n + v.size, 0) >= 2000) throw new Error('Too many open package editors. Close unused tabs.');
    entries.set(id, { owner, name, editing, part, touched: now });
    return [...entries].filter(([other]) => other !== id).map(([id, entry]) => ({ id, name: entry.name, editing: entry.editing, part: entry.part }));
  }

  leave(key: string, id: string, owner: string) {
    const entries = this.viewers.get(key);
    if (entries?.get(id)?.owner === owner) entries.delete(id);
    if (!entries?.size) this.viewers.delete(key);
  }

  private expire(now: number) {
    for (const [key, entries] of this.viewers) {
      for (const [id, entry] of entries) if (now - entry.touched >= this.ttl) entries.delete(id);
      if (!entries.size) this.viewers.delete(key);
    }
  }

  acquire(key: string): () => void {
    if (this.busy.has(key)) throw new Error('Another save for this package is in progress. Your edits are preserved; try again shortly.');
    this.busy.add(key);
    return () => { this.busy.delete(key); };
  }
}

export function assertPackageUnchanged(expected: unknown, actual: string | null | undefined) {
  const normalize = (text: string) => text.replace(/\r\n/g, '\n').trim();
  if (typeof expected !== 'string' || actual == null || normalize(expected) !== normalize(actual)) {
    throw new Error('This package changed in the database after you loaded it. Save blocked to protect newer code. Your edits are preserved: copy them, refresh the source, then reconcile your changes.');
  }
}
