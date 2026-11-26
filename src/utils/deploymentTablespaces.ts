import { quoteCompareIdentifier as qi } from './schemaCompare.ts';

export interface DeploymentTablespaces { tableTablespace?: string; indexTablespace?: string }
export function readDeploymentTablespaces(value: DeploymentTablespaces): DeploymentTablespaces {
  const read = (v: unknown, label: string) => {
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw new Error(label + ' must be an Oracle identifier.');
    const raw = v.trim();
    if (!raw) return undefined;
    const quoted = /^"(?:[^"]|"")+"$/.test(raw);
    if (!quoted && !/^[A-Za-z][A-Za-z0-9_$#]*$/.test(raw)) throw new Error('Invalid ' + label + '. Quote case-sensitive names.');
    const name = quoted ? raw.slice(1, -1).replace(/""/g, '"') : raw.toUpperCase();
    if (!name || new TextEncoder().encode(name).length > 128 || /[\x00-\x1f\x7f]/.test(name)) throw new Error(label + ' must contain 1–128 bytes without control characters.');
    return qi(name);
  };
  return { tableTablespace: read(value.tableTablespace, 'table tablespace'), indexTablespace: read(value.indexTablespace, 'index tablespace') };
}

type Token = { word?: string; identifier?: boolean; text: string; start: number; end: number; depth: number; close?: number };
function tokens(sql: string): Token[] {
  const out: Token[] = [], stack: number[] = [];
  for (let i = 0; i < sql.length;) {
    const start = i;
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) { const end = sql.indexOf('*/', i + 2); if (end < 0) throw new Error('Unclosed DDL comment.'); i = end + 2; continue; }
    if (/^[qQ]'/.test(sql.slice(i, i + 2))) {
      const delimiter = sql[i + 2], close = ({'[': ']', '(': ')', '{': '}', '<': '>'} as Record<string, string>)[delimiter] ?? delimiter;
      const end = sql.indexOf(close + "'", i + 3); if (end < 0) throw new Error('Unclosed DDL literal.'); i = end + 2; out.push({text: sql.slice(start, i), start, end: i, depth: stack.length}); continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]; let closed = false;
      while (i < sql.length) if (sql[i++] === quote) { if (sql[i] === quote) i++; else { closed = true; break; } }
      if (!closed) throw new Error('Unclosed quoted DDL token.');
      out.push({text: sql.slice(start, i), identifier: quote === '"', start, end: i, depth: stack.length}); continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$#]*/.exec(sql.slice(i));
    if (word) { i += word[0].length; out.push({text: word[0], word: word[0].toUpperCase(), identifier: true, start, end: i, depth: stack.length}); continue; }
    const text = sql[i++];
    if (text === ')') {
      const opening = stack.pop(); if (opening === undefined) throw new Error('Unbalanced DDL parentheses.');
      out[opening].close = out.length;
    }
    out.push({text, start, end: i, depth: stack.length});
    if (text === '(') stack.push(out.length - 1);
  }
  if (stack.length) throw new Error('Unbalanced DDL parentheses.');
  return out;
}

/** Only CREATE storage clauses are edited; literals, comments, SELECT bodies and ALTERs are preserved. */
export function applyCreationTablespaces(ddl: string, objectType: string, options: DeploymentTablespaces): string {
  const opts = readDeploymentTablespaces(options);
  if ((!opts.tableTablespace && !opts.indexTablespace) || !['TABLE', 'INDEX', 'MATERIALIZED VIEW', 'CLUSTER'].includes(objectType)) return ddl;
  const all = tokens(ddl), edits: {start: number; end: number; text: string}[] = [];
  const insert = (at: number, text: string) => edits.push({start: at, end: at, text});
  const replace = (token: Token, text: string) => edits.push({start: token.start, end: token.end, text});
  const starts = all.flatMap((t, i) => t.word === 'CREATE' && t.depth === 0 ? [i] : []);
  for (const start of starts) {
    let end = all.findIndex((t, i) => i > start && t.depth === 0 && t.text === ';');
    if (end < 0) end = all.length;
    const segment = all.slice(start, end);
    const kindIndex = segment.findIndex(t => t.depth === 0 && ['TABLE', 'INDEX', 'VIEW', 'CLUSTER'].includes(t.word ?? ''));
    if (kindIndex < 0) continue;
    const kindToken = segment[kindIndex], kind = kindToken.word === 'VIEW' && segment[kindIndex - 1]?.word === 'MATERIALIZED' ? 'MATERIALIZED VIEW' : kindToken.word!;
    if (!['TABLE', 'INDEX', 'MATERIALIZED VIEW', 'CLUSTER'].includes(kind)) continue;
    if (kind === 'INDEX' && !opts.indexTablespace) continue;
    if (kind === 'INDEX' && segment.some(t => t.depth === 0 && t.word === 'FROM')) throw new Error('Bitmap join index placement requires a reviewed index storage definition.');
    if (segment.slice(0, kindIndex).some(t => t.word === 'TEMPORARY') || segment.some((t, i) => t.word === 'ORGANIZATION' && segment[i + 1]?.word === 'EXTERNAL') || kind === 'TABLE' && segment.some(t => t.depth === 0 && t.word === 'CLUSTER')) throw new Error('Tablespace overrides require a stored segment; temporary, external and clustered tables need their own storage configuration.');
    const asIndex = segment.findIndex((t, i) => t.word === 'AS' && t.depth === 0 && segment[i - 1]?.word !== 'STORE');
    const bodyEnd = asIndex < 0 ? segment.length : asIndex;
    const ts = segment.slice(0, bodyEnd);
    let header = kindIndex + 1;
    if (!ts[header]?.identifier) throw new Error('Cannot locate CREATE object name for tablespace override.');
    header++;
    if (ts[header]?.text === '.') header += 2;
    if (ts[header]?.word === 'OF') {
      header++; if (!ts[header]?.identifier) throw new Error('Cannot locate object table type.');
      header++; if (ts[header]?.text === '.') header += 2;
    }
    let columnOpen: number | undefined;
    let clusterIndexEnd: number | undefined;
    if (kind === 'INDEX') {
      if (ts.some(t => t.depth === 0 && t.word === 'INDEXTYPE') && opts.indexTablespace) throw new Error('Domain index placement requires its index-type storage parameters.');
      const on = ts.findIndex(t => t.word === 'ON' && t.depth === 0);
      if (on < 0) throw new Error('Cannot locate CREATE INDEX target.');
      if (ts[on + 1]?.word === 'CLUSTER') {
        let name = on + 2; if (ts[name + 1]?.text === '.') name += 2;
        if (!ts[name]?.identifier) throw new Error('Cannot locate indexed cluster name.');
        clusterIndexEnd = ts[name].end;
      } else columnOpen = ts.findIndex((t, i) => i > on && t.depth === 0 && t.text === '(');
    } else if (ts[header]?.text === '(') columnOpen = header;
    if (kind === 'INDEX' && clusterIndexEnd === undefined && (columnOpen === undefined || columnOpen < 0)) throw new Error('Cannot locate CREATE INDEX column list.');
    let headerEnd = clusterIndexEnd ?? ts[header - 1].end;
    let columnClose: number | undefined;
    if (columnOpen !== undefined && columnOpen >= 0) {
      const closing = ts[columnOpen].close! - start;
      if (!ts[closing]) throw new Error('Cannot locate CREATE column list boundary.');
      columnClose = closing; headerEnd = ts[closing].end;
    }
    const nestedIndexes: {start: number; end: number}[] = [];
    const indexRanges: {from: number; to: number}[] = [];
    for (let i = 0; i < ts.length; i++) if (ts[i].word === 'USING' && ts[i + 1]?.word === 'INDEX') {
      const depth = ts[i].depth;
      let stop = i + 2;
      while (stop < ts.length && ts[stop].depth >= depth && !(ts[stop].depth === depth && (ts[stop].text === ',' || ['ENABLE', 'DISABLE', 'DEFERRABLE', 'INITIALLY', 'RELY', 'NORELY', 'REFRESH', 'BUILD', 'FOR', 'USING'].includes(ts[stop].word ?? '')))) stop++;
      indexRanges.push({from: i, to: stop});
      const next = ts[i + 2];
      if (next?.text === '(') {
        const closing = ts[next.close! - start];
        const inner = ddl.slice(next.end, closing.start);
        edits.push({start: next.end, end: closing.start, text: applyCreationTablespaces(inner, 'INDEX', opts)});
        nestedIndexes.push({start: next.start, end: closing.end});
      }
      const attributes = new Set(['PCTFREE', 'INITRANS', 'MAXTRANS', 'STORAGE', 'TABLESPACE', 'LOGGING', 'NOLOGGING', 'COMPRESS', 'NOCOMPRESS', 'PARALLEL', 'NOPARALLEL', 'LOCAL', 'GLOBAL', 'COMPUTE', 'SORT', 'NOSORT', 'REVERSE', 'INDEXING', 'VISIBLE', 'INVISIBLE', 'ONLINE', 'UNUSABLE', 'ENABLE', 'DISABLE', 'REFRESH', 'BUILD', 'FOR']);
      const namedReference = next?.identifier && (next.word === undefined || !attributes.has(next.word));
      if (opts.indexTablespace && !namedReference && next?.text !== '(' && !ts.slice(i + 2, stop).some(t => t.word === 'TABLESPACE')) insert(ts[i + 1].end, ' TABLESPACE ' + opts.indexTablespace);
    }
    const insideIndex = (i: number) => kind === 'INDEX' || indexRanges.some(r => i >= r.from && i < r.to);
    let rootTablespace = false;
    for (let i = 0; i < ts.length; i++) if (ts[i].word === 'TABLESPACE') {
      if (nestedIndexes.some(r => ts[i].start > r.start && ts[i].start < r.end)) continue;
      const next = ts[i + 1];
      if (next?.word === 'SET') throw new Error('TABLESPACE SET requires a dedicated placement mapping.');
      if (!next?.identifier) throw new Error('Missing TABLESPACE identifier in source DDL.');
      const index = insideIndex(i), target = index ? opts.indexTablespace : opts.tableTablespace;
      if (ts[i].depth === 0 && (kind === 'INDEX' || !index)) rootTablespace = true;
      if (target) replace(next, target);
    }
    for (let i = 0; i < ts.length; i++) if (ts[i].word === 'STORE' && ts[i + 1]?.word === 'IN' && ts[i + 2]?.text === '(' && !nestedIndexes.some(r => ts[i].start > r.start && ts[i].start < r.end)) {
      const target = insideIndex(i) ? opts.indexTablespace : opts.tableTablespace;
      const open = ts[i + 2], close = ts[open.close! - start];
      if (target) edits.push({start: open.end, end: close.start, text: target});
    }
    const primaryTarget = kind === 'INDEX' ? opts.indexTablespace : opts.tableTablespace;
    if (primaryTarget && !rootTablespace) insert(headerEnd, ' TABLESPACE ' + primaryTarget);
    const iot = ts.some((t, i) => t.word === 'ORGANIZATION' && ts[i + 1]?.word === 'INDEX');
    if (kind === 'TABLE' && opts.indexTablespace && !iot && columnOpen !== undefined && columnClose !== undefined) {
      for (let i = columnOpen + 1; i < columnClose; i++) if (ts[i].depth === 1 && (ts[i].word === 'UNIQUE' || ts[i].word === 'PRIMARY' && ts[i + 1]?.word === 'KEY')) {
        const keyEnd = ts[i].word === 'PRIMARY' ? i + 1 : i;
        let stop = keyEnd + 1;
        while (stop < columnClose && !(ts[stop].depth === 1 && ts[stop].text === ',')) stop++;
        if (ts.slice(keyEnd + 1, stop).some(t => t.word === 'USING' && ts[ts.indexOf(t) + 1]?.word === 'INDEX')) continue;
        const last = ts[keyEnd + 1]?.text === '(' ? ts[ts[keyEnd + 1].close! - start] : ts[keyEnd];
        insert(last.end, ' USING INDEX TABLESPACE ' + opts.indexTablespace);
      }
    }
    if (kind === 'MATERIALIZED VIEW' && opts.indexTablespace && !indexRanges.length && !ts.some((t, i) => t.word === 'USING' && ts[i + 1]?.word === 'NO' && ts[i + 2]?.word === 'INDEX')) {
      const before = ts.find(t => t.depth === 0 && ['REFRESH', 'NEVER', 'ENABLE', 'DISABLE'].includes(t.word ?? ''))?.start ?? segment[bodyEnd]?.start ?? (end < all.length ? all[end].start : ddl.length);
      insert(before, 'USING INDEX TABLESPACE ' + opts.indexTablespace + ' ');
    }
  }
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let result = ddl;
  for (const e of edits) result = result.slice(0, e.start) + e.text + result.slice(e.end);
  return result;
}
