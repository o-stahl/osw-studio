import { describe, it, expect } from 'vitest';
import { EVENT_CATALOG, DISCLOSURE_CATEGORIES, getDisclosureLines } from '../events';
import en from '@/messages/en.json';
import fi from '@/messages/fi.json';
import ko from '@/messages/ko.json';

describe('EVENT_CATALOG', () => {
  it('every event has a category and a disclosure line in every language', () => {
    for (const [name, def] of Object.entries(EVENT_CATALOG)) {
      expect(def.category, name).toBeTruthy();
      for (const [locale, messages] of Object.entries({ en, fi, ko })) {
        expect(messages.telemetry.lines[def.disclosure], `${locale}: ${name}`).toBeTruthy();
      }
    }
  });

  it('every category used by an event exists in DISCLOSURE_CATEGORIES', () => {
    const known = new Set(DISCLOSURE_CATEGORIES.map(c => c.id));
    for (const [name, def] of Object.entries(EVENT_CATALOG)) {
      expect(known.has(def.category), `${name}: ${def.category}`).toBe(true);
    }
  });

  // The dialog lists what the catalogue discloses. A line in the messages that no event points at
  // is a disclosure that silently stopped being shown, usually because an event was repointed.
  it('shows every disclosure line the messages hold', () => {
    const shown = new Set(getDisclosureLines().flatMap(g => g.lines));
    for (const line of Object.keys(en.telemetry.lines)) {
      expect(shown.has(line as never), line).toBe(true);
    }
  });

  it('still contains every pre-existing event name', () => {
    for (const legacy of ['session_start','pageview','heartbeat','provider_selected','model_selected','task_started','task_complete','task_fail','tool_call','api_error','project_create','deployment_publish','compaction_fired','image_attached','telemetry_disabled','telemetry_accepted']) {
      expect(EVENT_CATALOG[legacy as keyof typeof EVENT_CATALOG], legacy).toBeTruthy();
    }
  });
});

describe('getDisclosureLines', () => {
  it('groups by category and dedupes repeated disclosure lines', () => {
    const groups = getDisclosureLines();
    // Every group has a category and at least one line.
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.id).toBeTruthy();
      expect(g.lines.length).toBeGreaterThan(0);
      // Lines within a group are deduped (several events share one disclosure line).
      expect(new Set(g.lines).size).toBe(g.lines.length);
      // Each line is there because an event of this group's category discloses it.
      for (const line of g.lines) {
        const owned = Object.values(EVENT_CATALOG).some(d => d.category === g.id && d.disclosure === line);
        expect(owned, `${g.id}: ${line}`).toBe(true);
      }
    }
  });

  it('surfaces a line for every category that has events', () => {
    const groups = getDisclosureLines();
    const ids = new Set(groups.map(g => g.id));
    for (const cat of DISCLOSURE_CATEGORIES) {
      const hasEvent = Object.values(EVENT_CATALOG).some(d => d.category === cat.id);
      if (hasEvent) expect(ids.has(cat.id), cat.id).toBe(true);
    }
  });
});
