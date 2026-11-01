import { describe, it, expect } from 'vitest';
import { buildSpaceReadme } from '@/lib/publishing/hf-space-readme';

describe('buildSpaceReadme', () => {
  it('emits static-Space frontmatter with title, description, tag, and attribution', () => {
    const md = buildSpaceReadme({ title: 'My Site', shortDescription: 'A demo' });
    expect(md).toMatch(/^---\n/);
    expect(md).toContain('title: My Site');
    expect(md).toContain('sdk: static');
    expect(md).toContain('colorFrom: gray');
    expect(md).toContain('colorTo: gray');
    expect(md).toContain('short_description: A demo');
    expect(md).toContain('- osw-studio');
    expect(md).toContain('[OSW Studio](https://try.oswstudio.com)');
  });
  it('truncates short_description to 200 chars and strips newlines', () => {
    const md = buildSpaceReadme({ title: 'T', shortDescription: 'x'.repeat(300) + '\n\nmore' });
    const line = md.split('\n').find(l => l.startsWith('short_description:'))!;
    expect(line.length).toBeLessThanOrEqual('short_description: '.length + 200);
    expect(line).not.toContain('\n');
  });
  it('omits short_description line when empty', () => {
    const md = buildSpaceReadme({ title: 'T', shortDescription: '' });
    expect(md).not.toContain('short_description:');
  });
  it('escapes/quotes a title containing YAML-special characters', () => {
    const md = buildSpaceReadme({ title: 'a: b #c', shortDescription: '' });
    expect(md).toContain('title: "a: b #c"');
  });
});
