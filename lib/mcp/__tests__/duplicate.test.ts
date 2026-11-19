import { describe, it, expect } from 'vitest';
import { copyName } from '../duplicate';

describe('copyName', () => {
  it('cuts a long name so the copy suffix survives within 50 characters', () => {
    const long = 'A very long project name that runs well past the limit';
    const first = copyName(long, []);
    expect(first).toBe(`${long.slice(0, 43)} (Copy)`);
    expect(first).toHaveLength(50);

    const second = copyName(long, [first]);
    expect(second).toBe(`${long.slice(0, 41)} (Copy 2)`);
    expect(second).toHaveLength(50);
  });

  it('drops the space a cut leaves before the suffix', () => {
    // The cut at 43 characters ends on the space before "name".
    expect(copyName(`${'x'.repeat(42)} name`, [])).toBe(`${'x'.repeat(42)} (Copy)`);
  });
});
