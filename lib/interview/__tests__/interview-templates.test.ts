import { describe, it, expect } from 'vitest';
import { listInterviewTemplates, getInterviewTemplate, filterInterviewTemplates, isBuiltInInterviewTemplateId, asInterviewTemplate } from '../templates';
import { renderInterviewAgenda, withInterviewAgenda } from '../agenda';

describe('interview template registry', () => {
  it('exposes the built-in templates by id', () => {
    expect(getInterviewTemplate('understand-company')?.title).toBe('Understand a company');
    expect(getInterviewTemplate('plan-feature')?.title).toBe('Plan a feature');
    expect(getInterviewTemplate('nope')).toBeUndefined();
    expect(listInterviewTemplates().length).toBeGreaterThanOrEqual(2);
  });

  it('exposes the website and publish templates with their artifacts and handoffs', () => {
    const site = getInterviewTemplate('plan-website');
    expect(site?.title).toBe('Plan a website');
    expect(site?.artifacts[0].path).toBe('/.interviews/site-plan.md');
    expect(site?.handoff?.mode).toBe('code');

    const pub = getInterviewTemplate('prepare-publish');
    expect(pub?.title).toBe('Get ready to publish');
    expect(pub?.artifacts[0].path).toBe('/.interviews/publish-checklist.md');
    expect(pub?.handoff?.mode).toBe('code');
  });

  it('every built-in item is well-formed (id, elicit, completion)', () => {
    const templates = listInterviewTemplates();
    expect(templates.length).toBeGreaterThan(0);
    for (const t of templates) {
      expect(t.artifacts.length).toBeGreaterThan(0);
      expect(t.items.length).toBeGreaterThan(0);
      for (const item of t.items) {
        expect(item.id).toBeTruthy();
        expect(item.elicit).toBeTruthy();
        expect(item.completion.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('renderInterviewAgenda', () => {
  it('renders the title, artifact target, and each item elicit', () => {
    const t = getInterviewTemplate('understand-company')!;
    const agenda = renderInterviewAgenda(t);
    expect(agenda).toContain('Understand a company');
    expect(agenda).toContain('/.interviews/company-profile.md');
    for (const item of t.items) {
      expect(agenda).toContain(item.elicit);
    }
  });

  it('marks optional items', () => {
    const agenda = renderInterviewAgenda(getInterviewTemplate('understand-company')!);
    expect(agenda).toMatch(/optional/i);
  });

  it('does not leak raw completion assertions to the agent', () => {
    const t = getInterviewTemplate('plan-feature')!;
    const agenda = renderInterviewAgenda(t);
    expect(agenda).not.toContain('judge');
    for (const item of t.items) {
      for (const assertion of item.completion) {
        if (assertion.type === 'judge') {
          expect(agenda).not.toContain(assertion.criteria);
        }
      }
    }
  });
});

describe('filterInterviewTemplates', () => {
  const all = listInterviewTemplates();

  it('returns all templates for an empty or whitespace query', () => {
    expect(filterInterviewTemplates(all, '')).toHaveLength(all.length);
    expect(filterInterviewTemplates(all, '   ')).toHaveLength(all.length);
  });

  it('matches on title, case-insensitively', () => {
    const ids = filterInterviewTemplates(all, 'COMPANY').map(t => t.id);
    expect(ids).toContain('understand-company');
    expect(ids).not.toContain('plan-feature');
  });

  it('matches on description', () => {
    const ids = filterInterviewTemplates(all, 'spec').map(t => t.id);
    expect(ids).toContain('plan-feature');
    expect(ids).not.toContain('understand-company');
  });

  it('returns empty when nothing matches', () => {
    expect(filterInterviewTemplates(all, 'zzzzz')).toHaveLength(0);
  });
});

describe('isBuiltInInterviewTemplateId', () => {
  it('is true for built-ins and false otherwise', () => {
    expect(isBuiltInInterviewTemplateId('understand-company')).toBe(true);
    expect(isBuiltInInterviewTemplateId('my-custom-one')).toBe(false);
  });
});

describe('withInterviewAgenda', () => {
  it('appends the rendered agenda when the template id resolves', () => {
    const base = 'SYSTEM PROMPT';
    const result = withInterviewAgenda(base, 'understand-company');
    expect(result.startsWith(base)).toBe(true);
    expect(result).toContain('Understand a company');
    expect(result).toContain('/.interviews/company-profile.md');
    expect(result.length).toBeGreaterThan(base.length);
  });

  it('returns the prompt unchanged when no template id is given', () => {
    expect(withInterviewAgenda('SYSTEM PROMPT', undefined)).toBe('SYSTEM PROMPT');
  });

  it('returns the prompt unchanged when the template id is unknown', () => {
    expect(withInterviewAgenda('SYSTEM PROMPT', 'no-such-template')).toBe('SYSTEM PROMPT');
  });

  it('appends the agenda for a custom template passed in directly (not in the built-in registry)', () => {
    const base = 'SYSTEM PROMPT';
    const custom = {
      id: 'image-generation',
      title: 'Image generation',
      description: 'Creates an image generation prompt',
      artifacts: [{ path: '/.interviews/image-generation.md' }],
      items: [{ id: 'type', elicit: 'What type of image', completion: [{ type: 'judge' as const, criteria: 'The type of image is clear', description: 'type' }] }],
    };
    // The id does not resolve in the built-in registry, so only the passed object can supply the agenda.
    expect(withInterviewAgenda(base, 'image-generation')).toBe(base);
    const result = withInterviewAgenda(base, 'image-generation', custom);
    expect(result.startsWith(base)).toBe(true);
    expect(result).toContain('Image generation');
    expect(result).toContain('/.interviews/image-generation.md');
    expect(result).toContain('What type of image');
  });
});

describe('asInterviewTemplate', () => {
  it('takes every built-in as it is', () => {
    for (const template of listInterviewTemplates()) {
      expect(asInterviewTemplate(JSON.parse(JSON.stringify(template)))).toEqual(template);
    }
  });

  it('leaves the browser\'s bookkeeping behind', () => {
    const sent = { ...getInterviewTemplate('plan-feature')!, isBuiltIn: false, createdAt: '2026-11-03', lastSyncedAt: null };
    expect(asInterviewTemplate(sent)).toEqual(getInterviewTemplate('plan-feature'));
  });

  it('refuses what the agenda or the completion check could not read', () => {
    const base = getInterviewTemplate('plan-feature')!;
    expect(asInterviewTemplate(null)).toBeNull();
    expect(asInterviewTemplate({ ...base, title: 7 })).toBeNull();
    expect(asInterviewTemplate({ ...base, items: [{ id: 'a', elicit: 'e' }] })).toBeNull();
    expect(asInterviewTemplate({ ...base, items: [{ id: 'a', elicit: 'e', completion: [{ type: 'nope' }] }] })).toBeNull();
    expect(asInterviewTemplate({ ...base, items: [{ id: 'a', elicit: 'e', completion: [], required: 'yes' }] })).toBeNull();
    expect(asInterviewTemplate({ ...base, artifacts: [{ description: 'no path' }] })).toBeNull();
    expect(asInterviewTemplate({ ...base, handoff: { label: 'l', prompt: 'p', mode: 'interview' } })).toBeNull();
  });

  it('refuses a check type that only an object\'s own machinery answers to', () => {
    const base = getInterviewTemplate('plan-feature')!;
    for (const type of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(asInterviewTemplate({ ...base, items: [{ id: 'a', elicit: 'e', completion: [{ type }] }] }), type).toBeNull();
    }
  });
});
