import fs from 'node:fs';

/**
 * Helpers for a marker-delimited block that doku owns inside a file the user also
 * edits (git exclude, CLAUDE.local.md). Everything outside the markers is preserved.
 */
export interface Markers {
  start: string;
  end: string;
}

function locate(text: string, m: Markers): { from: number; to: number } | null {
  const from = text.indexOf(m.start);
  if (from === -1) return null;
  const endAt = text.indexOf(m.end, from);
  if (endAt === -1) return null;
  let to = endAt + m.end.length;
  if (text[to] === '\r') to++;
  if (text[to] === '\n') to++;
  return { from, to };
}

export function readBlock(text: string, m: Markers): string | null {
  const loc = locate(text, m);
  if (!loc) return null;
  const endAt = text.indexOf(m.end, loc.from);
  return text.slice(loc.from + m.start.length, endAt).replace(/^\r?\n|\r?\n$/g, '');
}

export function upsertBlock(text: string, m: Markers, body: string): string {
  const block = `${m.start}\n${body}\n${m.end}\n`;
  const loc = locate(text, m);
  if (loc) return text.slice(0, loc.from) + block + text.slice(loc.to);
  if (text === '') return block;
  const sep = text.endsWith('\n\n') ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return text + sep + block;
}

export function removeBlock(text: string, m: Markers): string {
  const loc = locate(text, m);
  if (!loc) return text;
  const before = text.slice(0, loc.from).replace(/\n\n$/, '\n');
  return before + text.slice(loc.to);
}

export function readFileOr(file: string, fallback = ''): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw err;
  }
}
