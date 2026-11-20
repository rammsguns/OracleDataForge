/** Filtering and ordering for the Copy table data table list. */

export type TableMatchMode = 'contains' | 'starts' | 'ends' | 'not-contains' | 'pattern';
export type TableSort = 'name-asc' | 'name-desc' | 'source-desc' | 'source-asc' | 'target-desc';

export const TABLE_MATCH_MODES: { value: TableMatchMode; label: string }[] = [
  { value: 'contains', label: 'Contains' },
  { value: 'starts', label: 'Starts with' },
  { value: 'ends', label: 'Ends with' },
  { value: 'not-contains', label: 'Doesn’t contain' },
  { value: 'pattern', label: 'Pattern (* ?)' },
];

export const TABLE_SORTS: { value: TableSort; label: string }[] = [
  { value: 'name-asc', label: 'Name A→Z' },
  { value: 'name-desc', label: 'Name Z→A' },
  { value: 'source-desc', label: 'Source rows, most first' },
  { value: 'source-asc', label: 'Source rows, fewest first' },
  { value: 'target-desc', label: 'Target rows, most first' },
];

/** Comma- or space-separated search terms, upper-cased (Oracle names are usually upper case). */
export function searchTerms(text: string): string[] {
  return text.split(/[\s,]+/).map(t => t.trim().toUpperCase()).filter(Boolean);
}

function patternRegex(term: string): RegExp {
  const body = term.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp('^' + body + '$');
}

/**
 * Whether `name` matches the search. With several terms, a name matches when any term matches,
 * except for "doesn't contain", where it must contain none of them. `_` and `%` are literal
 * (so CAT_ means the text "CAT_"); in pattern mode `*` is any text and `?` one character.
 * An empty search matches everything.
 */
export function tableNameMatches(name: string, text: string, mode: TableMatchMode): boolean {
  const terms = searchTerms(text);
  if (!terms.length) return true;
  const upper = name.toUpperCase();
  switch (mode) {
    case 'starts': return terms.some(t => upper.startsWith(t));
    case 'ends': return terms.some(t => upper.endsWith(t));
    case 'not-contains': return terms.every(t => !upper.includes(t));
    case 'pattern': return terms.some(t => patternRegex(t).test(upper));
    default: return terms.some(t => upper.includes(t));
  }
}

/** Returns a sorted copy. Unknown counts sort last; ties fall back to name order. */
export function sortTableNames(names: string[], sort: TableSort, sourceCounts: Record<string, number>, targetCounts: Record<string, number> = {}): string[] {
  const byName = (a: string, b: string) => a.localeCompare(b);
  const byCount = (counts: Record<string, number>, desc: boolean) => (a: string, b: string) => {
    const ca = counts[a], cb = counts[b];
    if (ca === undefined || cb === undefined) return ca === cb ? byName(a, b) : ca === undefined ? 1 : -1;
    return (desc ? cb - ca : ca - cb) || byName(a, b);
  };
  const compare = sort === 'name-desc' ? (a: string, b: string) => byName(b, a)
    : sort === 'source-desc' ? byCount(sourceCounts, true)
    : sort === 'source-asc' ? byCount(sourceCounts, false)
    : sort === 'target-desc' ? byCount(targetCounts, true)
    : byName;
  return [...names].sort(compare);
}

/** A min/max bound typed by the user: empty means no bound; otherwise a non-negative integer. */
export function parseCountBound(text: string): number | null | 'invalid' {
  const t = text.trim().replace(/[,_\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) && n >= 0 ? n : 'invalid';
}

/**
 * Whether `count` is within the inclusive [min, max] range typed by the user. Empty bounds don't
 * filter. When any bound is set, an unknown count doesn't match; an invalid bound is ignored.
 */
export function countInRange(count: number | undefined, minText: string, maxText: string): boolean {
  const min = parseCountBound(minText), max = parseCountBound(maxText);
  const lo = typeof min === 'number' ? min : null, hi = typeof max === 'number' ? max : null;
  if (lo === null && hi === null) return true;
  if (count === undefined) return false;
  return (lo === null || count >= lo) && (hi === null || count <= hi);
}

/** Source and target both have a known count and they are equal. */
export function sameRowCount(name: string, sourceCounts: Record<string, number>, targetCounts: Record<string, number> = {}): boolean {
  return sourceCounts[name] !== undefined && sourceCounts[name] === targetCounts[name];
}
