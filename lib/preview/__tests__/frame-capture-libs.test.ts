import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The painter a preview frame loads for a screenshot is served from `public/preview-capture/`,
 * copied there from node_modules by `postinstall`. A dependency upgrade without a reinstall would
 * leave the frame running the old copy; this catches it.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p));

describe('preview capture painter', () => {
  it('is the copy in node_modules', () => {
    const served = read('public/preview-capture/modern-screenshot.js');
    expect(served.equals(read('node_modules/modern-screenshot/dist/index.js'))).toBe(true);
  });
});
