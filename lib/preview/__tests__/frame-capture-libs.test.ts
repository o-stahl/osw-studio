import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The painters a preview frame loads for a screenshot are served from `public/preview-capture/`,
 * copied there from node_modules by `postinstall`. A dependency upgrade without a reinstall would
 * leave the frame running the old copy; this catches it.
 */

const ROOT = path.resolve(__dirname, '../../..');
const COPIES: Array<[string, string]> = [
  ['public/preview-capture/modern-screenshot.js', 'node_modules/modern-screenshot/dist/index.js'],
  ['public/preview-capture/html2canvas.js', 'node_modules/html2canvas/dist/html2canvas.min.js'],
];

describe('preview capture painters', () => {
  it.each(COPIES)('%s matches %s', (served, source) => {
    const read = (p: string) => fs.readFileSync(path.join(ROOT, p));
    expect(read(served).equals(read(source))).toBe(true);
  });
});
