import { describe, expect, it } from 'vitest';
import { readBlock, removeBlock, upsertBlock } from '../src/managedBlock.js';

const m = { start: '# doku:start', end: '# doku:end' };

describe('managed block', () => {
  it('appends to existing content with a blank line and round-trips on removal', () => {
    const original = 'node_modules\n';
    const added = upsertBlock(original, m, '/.doku');
    expect(added).toBe('node_modules\n\n# doku:start\n/.doku\n# doku:end\n');
    expect(removeBlock(added, m)).toBe(original);
  });

  it('replaces the block in place, keeping surrounding content', () => {
    const text = 'a\n\n# doku:start\nold\n# doku:end\nb\n';
    expect(upsertBlock(text, m, 'new')).toBe('a\n\n# doku:start\nnew\n# doku:end\nb\n');
  });

  it('reads the block body', () => {
    expect(readBlock('x\n# doku:start\n/a\n/b\n# doku:end\n', m)).toBe('/a\n/b');
    expect(readBlock('nothing here', m)).toBeNull();
  });

  it('handles an empty file', () => {
    const added = upsertBlock('', m, 'x');
    expect(added).toBe('# doku:start\nx\n# doku:end\n');
    expect(removeBlock(added, m)).toBe('');
  });
});
