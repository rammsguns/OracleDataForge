type Token = { text: string; start: number; end: number };
function tokens(source: string): Token[] {
  const re = /--[^\r\n]*|\/\*[\s\S]*?\*\/|q'([\[{(<])(?:[\s\S]*?)[\]})>]'|q'([^\w\s])(?:[\s\S]*?)\2'|'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_$#][\w$#]*|:=|\S/gi;
  return [...source.matchAll(re)].filter(m => !m[0].startsWith('--') && !m[0].startsWith('/*'))
    .map(m => ({ text: m[0].startsWith('"') || m[0].startsWith("'") ? m[0] : m[0].toUpperCase(), start: m.index!, end: m.index! + m[0].length }));
}
export type PackageHeader = { declaration: string; key: string; name: string };
function headers(source: string): PackageHeader[] {
  const ts = tokens(source);
  const out: PackageHeader[] = [];
  let i = ts.findIndex(t => t.text === 'PACKAGE');
  if (i < 0) throw new Error('Expected package source.');
  while (i < ts.length && !['AS', 'IS'].includes(ts[i].text)) i++;
  i++;
  function routine(collect: boolean) {
    const start = i++;
    const name = ts[i++]?.text;
    let depth = 0;
    while (i < ts.length) {
      const t = ts[i].text;
      if (t === '(') depth++;
      if (t === ')') depth--;
      if (!depth && ['AS', 'IS', ';'].includes(t)) break;
      i++;
    }
    if (i >= ts.length || !name) throw new Error('Could not read a routine header.');
    const header = ts.slice(start, i);
    // Defaults may be specified only in the spec; they do not distinguish overloads.
    let skip = false, nested = 0;
    const key = header.filter(t => {
      if (t.text === '(') nested++;
      if (t.text === ')') nested--;
      if (nested === 1 && ['DEFAULT', ':='].includes(t.text)) { skip = true; return false; }
      if ((t.text === ',' && nested === 1) || (t.text === ')' && nested === 0)) skip = false;
      return !skip;
    }).map(t => t.text).filter((text, index, all) => text !== 'IN' || all[index + 1] === 'OUT').join(' ').replace(/ \( \)/g, '');
    if (collect) out.push({ name, key, declaration: source.slice(ts[start].start, ts[i - 1].end).trim() + ';' });
    if (ts[i++].text === ';') return;
    // Skip local declarations, including nested subprograms.
    while (i < ts.length && ts[i].text !== 'BEGIN') {
      if (['PROCEDURE', 'FUNCTION'].includes(ts[i].text)) routine(false);
      else i++;
    }
    let blocks = 0;
    while (i < ts.length) {
      const t = ts[i++].text;
      if (['BEGIN', 'IF', 'LOOP', 'CASE'].includes(t)) blocks++;
      if (t === 'END') {
        blocks--;
        if (['IF', 'LOOP', 'CASE'].includes(ts[i]?.text)) i++;
        if (blocks === 0) {
          while (i < ts.length && ts[i].text !== ';') i++;
          i++;
          return;
        }
      }
    }
    throw new Error('Could not locate the end of a package routine.');
  }
  while (i < ts.length && !['BEGIN', 'END'].includes(ts[i].text)) {
    if (['PROCEDURE', 'FUNCTION'].includes(ts[i].text)) routine(true);
    else i++;
  }
  return out;
}
export function missingPackageHeaders(spec: string, body: string): PackageHeader[] {
  const existing = new Set(headers(spec).map(h => h.key));
  return headers(body).filter(h => { if (existing.has(h.key)) return false; existing.add(h.key); return true; });
}
export function syncPackageSpec(spec: string, selected: PackageHeader[]): string {
  const ts = tokens(spec);
  const end = [...ts].reverse().find(t => t.text === 'END');
  if (!end) throw new Error('Could not locate the end of the package specification.');
  return spec.slice(0, end.start) + selected.map(h => '  ' + h.declaration).join('\n\n') + '\n' + spec.slice(end.start);
}
