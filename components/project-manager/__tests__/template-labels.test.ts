import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/vfs', () => ({ vfs: {} }));

import { templateDisplayName, templateDescription } from '../index';
import { BUILT_IN_TEMPLATES } from '@/lib/vfs/project-templates';
import type { CustomTemplate } from '@/lib/vfs/types';

/** How the create dialog names and describes the template picked. */
const t = (key: string) => `<${key}>`;
const blog = BUILT_IN_TEMPLATES.find((tpl) => tpl.id === 'blog')!;
const CATALOG = { blog: { name: 'Blogi', description: 'Artikkelit ja arkisto' } };
const CUSTOM = [
  { id: 'c1', name: 'Shop', description: 'Our shop starter' },
  { id: 'c2', name: '', description: '' },
] as unknown as CustomTemplate[];

describe('templateDisplayName', () => {
  it('names a built-in template in the interface language', () => {
    expect(templateDisplayName('blog', CUSTOM, CATALOG, t)).toBe('Blogi');
  });

  it('falls back to the registry name when the catalog has no entry', () => {
    expect(templateDisplayName('blog', CUSTOM, {}, t)).toBe(blog.name);
  });

  it('names a custom template by its own name, or generically when it has none', () => {
    expect(templateDisplayName('custom:c1', CUSTOM, CATALOG, t)).toBe('Shop');
    expect(templateDisplayName('custom:c2', CUSTOM, CATALOG, t)).toBe('<customTemplate>');
    expect(templateDisplayName('custom:gone', CUSTOM, CATALOG, t)).toBe('<customTemplate>');
  });

  it('asks for a template when the id is unknown', () => {
    expect(templateDisplayName('no-such-template', CUSTOM, CATALOG, t)).toBe('<selectTemplate>');
  });
});

describe('templateDescription', () => {
  it('describes a built-in template in the interface language, else from the registry', () => {
    expect(templateDescription('blog', CUSTOM, CATALOG)).toBe('Artikkelit ja arkisto');
    expect(templateDescription('blog', CUSTOM, {})).toBe(blog.description ?? '');
  });

  it('uses a custom template\'s own description', () => {
    expect(templateDescription('custom:c1', CUSTOM, CATALOG)).toBe('Our shop starter');
  });

  it('is empty when there is nothing to say', () => {
    expect(templateDescription('custom:c2', CUSTOM, CATALOG)).toBe('');
    expect(templateDescription('custom:gone', CUSTOM, CATALOG)).toBe('');
    expect(templateDescription('no-such-template', CUSTOM, CATALOG)).toBe('');
  });
});
