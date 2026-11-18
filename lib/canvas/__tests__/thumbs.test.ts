import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { canvasThumbs, MAX_ENTRIES } from '../thumbs';

const blob = (text: string) => new Blob([text], { type: 'image/jpeg' });

describe('the thumbnail cache', () => {
  it('answers for the page signature it was taken at, and per project', async () => {
    const a = canvasThumbs('project-a');
    await a.put('/index.html', 'desktop', 'sig1', blob('one'));
    expect(await (await a.get('/index.html', 'desktop', 'sig1'))!.text()).toBe('one');
    expect(await a.get('/index.html', 'desktop', 'sig2')).toBeNull();
    expect(await a.get('/index.html', 'phone', 'sig1')).toBeNull();
    expect(await canvasThumbs('project-b').get('/index.html', 'desktop', 'sig1')).toBeNull();
  });

  it('keeps the newest thumbnail for an artboard', async () => {
    const c = canvasThumbs('project-c');
    await c.put('/a.html', 'phone', 'v1', blob('old'));
    await c.put('/a.html', 'phone', 'v2', blob('new'));
    expect(await c.get('/a.html', 'phone', 'v1')).toBeNull();
    expect(await (await c.get('/a.html', 'phone', 'v2'))!.text()).toBe('new');
  });

  it('lets the oldest go past its cap', async () => {
    const d = canvasThumbs('project-d');
    for (let i = 0; i <= MAX_ENTRIES + 2; i++) await d.put(`/p${i}.html`, 'desktop', 's', blob(String(i)));
    // MAX_ENTRIES + 3 written: the three oldest of them go (with anything older), the rest stay.
    expect(await d.get('/p0.html', 'desktop', 's')).toBeNull();
    expect(await d.get('/p2.html', 'desktop', 's')).toBeNull();
    expect(await (await d.get('/p3.html', 'desktop', 's'))!.text()).toBe('3');
    expect(await (await d.get(`/p${MAX_ENTRIES + 2}.html`, 'desktop', 's'))!.text()).toBe(String(MAX_ENTRIES + 2));
  });
});
