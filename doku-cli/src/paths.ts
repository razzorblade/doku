import path from 'node:path';
import { DokuError } from './errors.js';

const isWin = process.platform === 'win32';

/** Strip the `\\?\` / `\??\` prefixes Windows may put on junction targets. */
export function normalizeTarget(p: string): string {
  return path.resolve(p.replace(/^\\\\\?\\|^\\\?\?\\/, ''));
}

export function samePath(a: string, b: string): boolean {
  const na = normalizeTarget(a);
  const nb = normalizeTarget(b);
  return isWin ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** True when `child` is `parent` itself or somewhere below it. */
export function isInside(child: string, parent: string): boolean {
  let rel = path.relative(normalizeTarget(parent), normalizeTarget(child));
  if (isWin) rel = rel.toLowerCase();
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Validate a single path segment used as a storage project name or link folder name. */
export function assertSegment(value: string, what: string): void {
  const invalid =
    !value ||
    value === '.' ||
    value === '..' ||
    /[<>:"/\\|?*\x00-\x1f]/.test(value) ||
    /[. ]$/.test(value);
  if (invalid) {
    throw new DokuError(`Invalid ${what} "${value}": use a plain folder name without slashes or special characters.`);
  }
}

export function assertLocalPath(p: string, what: string): void {
  if (isWin && p.startsWith('\\\\')) {
    throw new DokuError(`${what} "${p}" is a network path; Windows junctions only work with local drives.`);
  }
}
