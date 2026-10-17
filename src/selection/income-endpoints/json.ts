/** JSON.parse accepts duplicate keys. Proofs and operator-facing mutations must have one unambiguous meaning. */
export function incomeStrictJson(text: string): unknown {
  const result: unknown = JSON.parse(text);
  let offset = 0, tokens = 0;
  function whitespace() { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; }
  function quoted(): string {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') { offset += 2; continue; }
      if (text[offset++] === '"') {
        const value: unknown = JSON.parse(text.slice(start, offset));
        if (typeof value !== 'string') throw new Error('Invalid JSON string'); return value;
      }
    }
    throw new Error('Unfinished JSON string');
  }
  function value(depth: number): void {
    if (++tokens > 8192 || depth > 32) throw new Error('JSON structure limit');
    whitespace(); const first = text[offset];
    if (first === '{') {
      offset++; whitespace(); const keys = new Set<string>();
      if (text[offset] === '}') { offset++; return; }
      while (true) {
        whitespace(); if (text[offset] !== '"') throw new Error('Invalid JSON key');
        const key = quoted(); if (keys.has(key)) throw new Error('Duplicate JSON key'); keys.add(key);
        whitespace(); if (text[offset++] !== ':') throw new Error('Invalid JSON colon');
        value(depth + 1); whitespace(); const next = text[offset++];
        if (next === '}') return; if (next !== ',') throw new Error('Invalid JSON object');
      }
    }
    if (first === '[') {
      offset++; whitespace(); if (text[offset] === ']') { offset++; return; }
      while (true) { value(depth + 1); whitespace(); const next = text[offset++];
        if (next === ']') return; if (next !== ',') throw new Error('Invalid JSON array'); }
    }
    if (first === '"') { quoted(); return; }
    const atom = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(offset));
    if (!atom) throw new Error('Invalid JSON value'); offset += atom[0].length;
  }
  value(0); whitespace(); if (offset !== text.length) throw new Error('Trailing JSON'); return result;
}
