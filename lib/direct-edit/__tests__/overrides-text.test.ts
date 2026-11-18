import { describe, it, expect, vi } from 'vitest';
import { OverridesText } from '../overrides-text';

/** A load whose answers the test hands out one at a time. */
function gatedLoad() {
  const waiting: ((text: string) => void)[] = [];
  const load = vi.fn(() => new Promise<string>(resolve => { waiting.push(resolve); }));
  return { load, answer: (text: string) => waiting.shift()!(text) };
}

describe('OverridesText', () => {
  it('reads storage once and answers from the copy after that', async () => {
    const load = vi.fn(async () => 'a{}');
    const text = new OverridesText(load);
    expect(await text.read()).toBe('a{}');
    expect(await text.read()).toBe('a{}');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reads storage again after a drop', async () => {
    let file = 'a{}';
    const load = vi.fn(async () => file);
    const text = new OverridesText(load);
    await text.read();
    file = 'b{}';
    text.drop();
    expect(await text.read()).toBe('b{}');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('answers a write over a read that was out when it landed', async () => {
    const { load, answer } = gatedLoad();
    const text = new OverridesText(load);
    const reading = text.read();
    text.set('written{}');
    answer('older{}');
    expect(await reading).toBe('written{}');
    expect(await text.read()).toBe('written{}');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reads again when the file was dropped while a read was out', async () => {
    const { load, answer } = gatedLoad();
    const text = new OverridesText(load);
    const reading = text.read();
    text.drop();
    answer('older{}');
    await Promise.resolve();
    answer('newer{}');
    expect(await reading).toBe('newer{}');
  });

  it('keeps what a write reports', async () => {
    const load = vi.fn(async () => 'stored{}');
    const text = new OverridesText(load);
    const result = await text.track(async () => ({ css: 'written{}' }), r => r.css);
    expect(result).toEqual({ css: 'written{}' });
    expect(await text.read()).toBe('written{}');
    expect(load).not.toHaveBeenCalled();
  });

  it('keeps nothing from a write the file changed under', async () => {
    // The write's own stamp into a page is one such change: it dispatches the event that drops.
    const load = vi.fn(async () => 'stored{}');
    const text = new OverridesText(load);
    await text.track(async () => { text.drop(); return { css: 'written{}' }; }, r => r.css);
    expect(await text.read()).toBe('stored{}');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keeps nothing from a write that reports no file', async () => {
    const load = vi.fn(async () => 'stored{}');
    const text = new OverridesText(load);
    await text.track(async () => ({ css: undefined }), r => r.css);
    expect(await text.read()).toBe('stored{}');
  });
});
