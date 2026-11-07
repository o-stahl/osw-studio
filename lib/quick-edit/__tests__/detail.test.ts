import { describe, it, expect } from 'vitest';
import { stepDetail, reasoningHead, reasoningTail } from '@/lib/quick-edit/detail';
import type { DebugEvent } from '@/lib/stores/types';

/**
 * An opened group, row by row: reasoning where it was thought, steps where they ran, each step with
 * the calls it stands for as the chat panel's `EventProcessor` parses them.
 */

let seq = 0;
const ev = (event: string, data: unknown = {}): DebugEvent => ({
  id: `d${++seq}`, timestamp: seq, event, data, count: 1, version: 1,
});
const turn = () => ev('iteration', { current: 1 });
const call = (id: string, command: string) => ev('toolCalls', { toolCalls: [{ id, function: { name: 'bash', arguments: JSON.stringify({ command }) } }] });
const run = (id: string, command: string) => ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });
const done = (id: string, result = 'ok') => ev('tool_status', { toolCallId: id, toolName: 'bash', status: 'completed', result });
const thought = (text: string) => ev('reasoning_delta', { all: [{ text }] });
const rows = (events: DebugEvent[], live = true) => stepDetail(events, live).map((r) => (r.kind === 'reasoning' ? `thought:${r.text}` : r.kind === 'forming' ? `writing:${r.step.kind}:${r.step.lines}` : `step:${r.step.kind}x${r.step.steps}`));

describe('stepDetail', () => {
  it('puts each stretch of reasoning before the steps it led to', () => {
    expect(rows([
      turn(), thought('Need the page first.'), call('k1', 'cat /a.html'), run('k1', 'cat /a.html'), done('k1'),
      turn(), thought('Now the styles.'), call('k2', 'ss /a.css'), run('k2', 'ss /a.css'), done('k2'),
    ])).toEqual(['thought:Need the page first.', 'step:readx1', 'thought:Now the styles.', 'step:editx1']);
  });

  it('counts a repeat on either side of a thought as two rows, each where it ran', () => {
    expect(rows([
      turn(), call('k1', 'ss /a.css'), run('k1', 'ss /a.css'), done('k1'),
      turn(), thought('Again.'), call('k2', 'ss /a.css'), run('k2', 'ss /a.css'), done('k2'),
    ])).toEqual(['step:editx1', 'thought:Again.', 'step:editx1']);
  });

  it('hands each step the calls it collapsed, as the event processor reads them', () => {
    const detail = stepDetail([
      turn(), call('k1', 'cat /a.html'), run('k1', 'cat /a.html'), done('k1', '<h1>Hi</h1>'),
      call('k2', 'cat /a.html'), run('k2', 'cat /a.html'), done('k2', '<h1>Hi</h1>'),
    ], false);
    expect(detail).toHaveLength(1);
    const step = detail[0] as Extract<ReturnType<typeof stepDetail>[number], { kind: 'step' }>;
    expect(step.calls.map((c) => c.id)).toEqual(['k1', 'k2']);
    expect(step.calls[0]).toMatchObject({ parameters: { command: 'cat /a.html' }, status: 'completed', result: '<h1>Hi</h1>' });
  });

  it('places reasoning that came only with the finished message where its response began', () => {
    expect(rows([
      turn(), call('k1', 'cat /a.html'), run('k1', 'cat /a.html'), done('k1'),
      turn(), call('k2', 'ss /a.css'), run('k2', 'ss /a.css'), done('k2'),
      ev('conversation_message', { message: { role: 'assistant', content: '', reasoning_details: [{ text: 'Now the styles.' }], tool_calls: [] } }),
    ])).toEqual(['step:readx1', 'thought:Now the styles.', 'step:editx1']);
  });

  it('takes reasoning the run ended in the middle of as finished, once the group is over', () => {
    expect(stepDetail([turn(), thought('Then the foot')], true)[0]).toMatchObject({ kind: 'reasoning', complete: false });
    expect(stepDetail([turn(), thought('Then the foot')], false)[0]).toMatchObject({ kind: 'reasoning', complete: true });
  });

  it('does not show a thought twice when it was streamed and also came with the message', () => {
    expect(rows([
      turn(), thought('Now the styles.'), call('k2', 'ss /a.css'), run('k2', 'ss /a.css'), done('k2'),
      ev('conversation_message', { message: { role: 'assistant', content: '', reasoning_details: [{ text: 'Now the styles.' }], tool_calls: [] } }),
    ])).toEqual(['thought:Now the styles.', 'step:editx1']);
  });
});

describe('the call being written, in an opened group', () => {
  it('ends the rows with it while it has not started running', () => {
    const streaming = ev('tool_param_delta', { all: [{ toolId: 'k2', fragment: '{"command": "cat > /a.html << \'EOF\'\\n<p>one</p>\\n<p>two' }] });
    expect(rows([
      turn(), call('k1', 'cat /index.html'), run('k1', 'cat /index.html'), done('k1'),
      turn(), ev('toolCalls', { toolCalls: [{ id: 'k2', function: { name: 'bash', arguments: '' } }] }), streaming,
    ])).toEqual(['step:readx1', 'writing:write:2']);
  });

  it('is not there once the group is over, though the call never ran', () => {
    expect(rows([
      turn(), call('k1', 'cat /index.html'), run('k1', 'cat /index.html'), done('k1'),
      turn(), ev('toolCalls', { toolCalls: [{ id: 'k2', function: { name: 'bash', arguments: '' } }] }),
      ev('tool_param_delta', { all: [{ toolId: 'k2', fragment: '{"command": "cat > /footer.html' }] }),
    ], false)).toEqual(['step:readx1']);
  });

  it('is never a call an earlier response left unrun, as the wrong-tool retry leaves one', () => {
    expect(rows([
      turn(), ev('toolCalls', { toolCalls: [{ id: 'k1', function: { name: 'bash', arguments: '' } }] }),
      ev('tool_param_delta', { all: [{ toolId: 'k1', fragment: '{"command": "cat > /footer.html' }] }),
      turn(), thought('Use bash for that.'),
    ])).toEqual(['thought:Use bash for that.']);
  });

  it('drops it once the call runs, when it is a step like the others', () => {
    expect(rows([
      turn(), call('k1', 'ss /a.css'), run('k1', 'ss /a.css'),
    ])).toEqual(['step:editx1']);
  });
});

describe('reasoning as a row reads it', () => {
  it('heads a finished stretch with its first paragraph, code marks dropped', () => {
    expect(reasoningHead('Append before final `})();`.\n\nThen the styles.')).toBe('Append before final })();.');
  });

  it('shows a stretch still being written by its newest words, from a word, after an ellipsis', () => {
    const text = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen.';
    expect(reasoningTail(text, 30)).toBe('…twelve thirteen fourteen.');
    expect(reasoningTail('Short.', 30)).toBe('Short.');
    expect(reasoningTail('```css\n.plan .btn { }\n```', 30)).toBe('.plan .btn { }');
  });
});
