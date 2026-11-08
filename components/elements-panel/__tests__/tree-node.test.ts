import { describe, it, expect } from 'vitest';
import { basename, formatClassName, sourceTitle } from '../tree-node';

/**
 * The row's text derivations. The markup itself is not asserted — there is no React Testing Library
 * here, and a shallow assertion on JSX would test the test.
 */

describe('basename', () => {
  it('shows the file, not the path', () => {
    expect(basename('/partials/nav.hbs')).toBe('nav.hbs');
    expect(basename('/index.hbs')).toBe('index.hbs');
  });

  it('leaves a bare filename alone', () => {
    expect(basename('index.hbs')).toBe('index.hbs');
  });

  it('falls back to the path rather than rendering an empty badge', () => {
    expect(basename('/partials/')).toBe('/partials/');
    expect(basename('/')).toBe('/');
  });

  it('handles a path containing a colon, which the serializer splits on the last one', () => {
    expect(basename('/a:b/c.html')).toBe('c.html');
  });
});

describe('sourceTitle', () => {
  const t = (_key: 'sourceOffset', v: { file: string; offset: number }) => `${v.file} @${v.offset}`;

  it('carries the full path, which is what the badge cannot show', () => {
    expect(sourceTitle({ file: '/partials/nav.hbs', line: undefined }, t)).toBe('/partials/nav.hbs');
  });

  it('labels the offset as one, because it is not a line number', () => {
    expect(sourceTitle({ file: '/partials/nav.hbs', line: 120 }, t)).toBe('/partials/nav.hbs @120');
    expect(sourceTitle({ file: '/index.hbs', line: 0 }, t)).toBe('/index.hbs @0');
  });

  it('has nothing to say for an element with no source', () => {
    expect(sourceTitle({ file: undefined, line: undefined }, t)).toBeUndefined();
  });
});

describe('formatClassName', () => {
  it('renders classes the way a selector reads', () => {
    expect(formatClassName('post')).toBe('.post');
    expect(formatClassName('post featured')).toBe('.post.featured');
  });

  it('caps the stack and counts the rest instead of dropping it silently', () => {
    expect(formatClassName('a b c d')).toBe('.a.b +2');
  });

  it('survives the whitespace a template actually emits', () => {
    expect(formatClassName('  post\n  featured  ')).toBe('.post.featured');
  });

  it('renders nothing for an element with no class', () => {
    expect(formatClassName(undefined)).toBe('');
    expect(formatClassName('   ')).toBe('');
  });
});
