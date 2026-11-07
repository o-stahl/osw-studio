import { describe, it, expect } from 'vitest';
import { splitRuns, type RunSegment } from '@/lib/quick-edit/runs';
import type { DebugEvent } from '@/lib/stores/types';

type Group = Extract<RunSegment, { kind: 'steps' }>;

let seq = 0;
const ev = (event: string, data: unknown = {}): DebugEvent => ({
  id: `e${++seq}`, timestamp: seq, event, data, count: 1, version: 1,
});
const user = (content: unknown) => ev('conversation_message', { message: { role: 'user', content } });
const assistant = (content: unknown) => ev('conversation_message', { message: { role: 'assistant', content } });
const running = (command: string) =>
  ev('tool_status', { toolCallId: `c${seq + 1}`, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });

describe('splitRuns', () => {
  it('has no runs before anyone asked for anything', () => {
    expect(splitRuns([ev('project_context'), running('ls /')])).toEqual([]);
  });

  it('cuts one run per request, in order', () => {
    const runs = splitRuns([user('Make it blue'), running('ss /a.css'), user('Now green'), running('ss /a.css')]);
    expect(runs.map((r) => r.request)).toEqual(['Make it blue', 'Now green']);
    expect(runs.map((r) => r.tally.commandCount)).toEqual([1, 1]);
  });

  it('keys each run by its request event', () => {
    const first = user('One');
    expect(splitRuns([first, running('ls /')])[0].id).toBe(first.id);
  });

  it('reads a request written as content blocks, ignoring the images in it', () => {
    const run = splitRuns([user([{ type: 'text', text: 'Match this' }, { type: 'image_url', image_url: { url: 'data:...' } }])])[0];
    expect(run.request).toBe('Match this');
  });

  it('keeps what happened in order: prose, then a folded stretch of steps, then prose', () => {
    const run = splitRuns([
      user('Fix it'),
      assistant(''),
      assistant('Working on it.'),
      running('cat /a.css'),
      running('ss /a.css'),
      assistant('Done. The header is blue now.'),
    ])[0];
    expect(run.segments.map((s) => s.kind)).toEqual(['text', 'steps', 'text']);
    expect(run.segments[0]).toEqual({ kind: 'text', text: 'Working on it.' });
    expect((run.segments[1] as { tally: { commandCount: number } }).tally.commandCount).toBe(2);
    expect(run.segments[2]).toEqual({ kind: 'text', text: 'Done. The header is blue now.' });
  });

  it('keeps reasoning out of the prose: the message\'s words are the segment, its reasoning sits before it', () => {
    const message = ev('conversation_message', { message: { role: 'assistant', content: 'I will change the colour.', reasoning_details: [{ text: 'The user wants blue.' }] } });
    const run = splitRuns([user('Fix it'), message])[0];
    expect(run.segments.map((s) => s.kind)).toEqual(['reasoning', 'text']);
    expect(run.segments[1]).toEqual({ kind: 'text', text: 'I will change the colour.' });
    // The message goes with the reasoning, which a replayed run carries only there.
    expect((run.segments[0] as Extract<RunSegment, { kind: 'reasoning' }>).events).toContain(message);
  });

  it('reports what the agent is doing right now from the last event', () => {
    expect(splitRuns([user('Fix it'), ev('reasoning_start'), ev('reasoning_delta', { text: 'x' })])[0].activity).toBe('thinking');
    expect(splitRuns([user('Fix it'), ev('assistant_delta', { text: 'I' })])[0].activity).toBe('writing');
    expect(splitRuns([user('Fix it'), running('cat /a.html')])[0].activity).toBe('working');
    expect(splitRuns([user('Fix it'), ev('reasoning_delta', { text: 'x' }), assistant('Done.')])[0].activity).toBeNull();
    expect(splitRuns([user('Fix it')])[0].activity).toBeNull();
  });

  it('closes a stretch of steps when the run ends without the agent speaking', () => {
    const run = splitRuns([user('Fix it'), running('ss /a.css')])[0];
    expect(run.segments.map((s) => s.kind)).toEqual(['steps']);
  });

  it('has no segments when the agent did nothing and said nothing', () => {
    expect(splitRuns([user('Fix it')])[0].segments).toEqual([]);
  });

  it('takes the checkpoint the run finished on', () => {
    const run = splitRuns([user('Fix it'), ev('checkpoint_created', { checkpointId: 'cp_1' }), ev('task_complete')])[0];
    expect(run.checkpointId).toBe('cp_1');
  });

  it('does not start a run at a message the harness sent as the user', () => {
    const runs = splitRuns([
      user('Fix it'),
      running('ss /a.css'),
      user('Before finishing, run the status command: status --task "…"'),
      running('status done'),
      user('<automated_reminder>keep going</automated_reminder>'),
    ]);
    expect(runs.map((r) => r.request)).toEqual(['Fix it']);
    expect(runs[0].tally.commandCount).toBe(2);
  });

  it('does not start a run at a synthetic error, which is also sent as the user', () => {
    const runs = splitRuns([
      user('Fix it'),
      ev('conversation_message', { message: { role: 'user', content: 'Error: boom', ui_metadata: { isSyntheticError: true } } }),
    ]);
    expect(runs).toHaveLength(1);
  });

  it('shows the words the person typed, not the context the client wrapped around them', () => {
    const run = splitRuns([
      ev('conversation_message', { message: { role: 'user', content: 'Fix it\n\n- /.skills/x.md: use this', ui_metadata: { displayContent: 'Fix it' } } }),
    ])[0];
    expect(run.request).toBe('Fix it');
  });

  it('carries the gated command a waiting run is stopped on, with its command line, and only while it waits', () => {
    // The studio's card shows the command line; the simple view leaves it out.
    const waiting = splitRuns([
      user('Remove the old page'),
      ev('approval_required', { gateKey: 'rm', command: 'rm /old.html', capabilityLabel: 'rm / rmdir (delete)' }),
    ])[0];
    expect(waiting.tally.status).toBe('waiting');
    expect(waiting.approval).toEqual({ gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)', command: 'rm /old.html' });

    const resumed = splitRuns([
      user('Remove the old page'),
      ev('approval_required', { gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)' }),
      ev('task_complete'),
    ])[0];
    expect(resumed.approval).toBeNull();
  });

  it('carries the request\'s context marking, as the workspace shows it', () => {
    const focusContext = { domPath: 'body>h1', snippet: '<h1>Hi</h1>' };
    const semanticBlocks = [{ name: 'Hero', domPath: 'body>section', position: 'after', description: 'A hero' }];
    const attachedFiles = [{ name: 'brief.md' }];
    const runs = splitRuns([
      ev('conversation_message', {
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Make it blue' }, { type: 'image_url', image_url: { url: 'data:,' } }],
          ui_metadata: { focusContext, semanticBlocks, attachedFiles },
        },
      }),
      running('ss /a.css'),
    ]);
    expect(runs[0].context.focusContext).toEqual(focusContext);
    expect(runs[0].context.semanticBlocks).toEqual(semanticBlocks);
    expect(runs[0].context.attachedFiles).toEqual(attachedFiles);
    expect(runs[0].context.contentBlocks).toHaveLength(1);
  });

  it('gives a request that came with nothing an empty context', () => {
    expect(splitRuns([user('Just words'), running('ls /')])[0].context).toEqual({});
  });

  it('does not let one run\'s events leak into the next', () => {
    const runs = splitRuns([
      user('A'), ev('checkpoint_created', { checkpointId: 'cp_a' }), assistant('Did A.'),
      user('B'), running('cat /x.html'),
    ]);
    expect(runs[1].checkpointId).toBeNull();
    expect(runs[1].segments.map((s) => s.kind)).toEqual(['steps']);
    expect(runs[0].tally.commandCount).toBe(0);
  });
});

/**
 * The parts of a run the thread shows: prose where the model wrote it, notices in order, and what
 * each group of steps and the whole run cost. Timed events, since the run's usage line reports its
 * time.
 */
describe('splitRuns, message by message', () => {
  let n = 0;
  const at = (ms: number, event: string, data: unknown = {}): DebugEvent => ({
    id: `t${++n}`, timestamp: 10_000 + ms, event, data, count: 1, version: 1,
  });
  const ask = (ms: number) => at(ms, 'conversation_message', { message: { role: 'user', content: 'Fix it' } });
  const turn = (ms: number) => at(ms, 'iteration', { current: 1 });
  const run = (ms: number, id: string, command: string) =>
    at(ms, 'tool_status', { toolCallId: id, toolName: 'bash', status: 'executing', args: JSON.stringify({ command }) });
  const done = (ms: number, id: string) => at(ms, 'tool_status', { toolCallId: id, toolName: 'bash', status: 'completed', result: 'ok' });
  const said = (ms: number, content: string) =>
    at(ms, 'conversation_message', { message: { role: 'assistant', content, tool_calls: [] } });
  /** An orchestrator usage event: the one the run's usage line sums, with the call it reports. */
  const spent = (ms: number, totalTokens: number, cost: number) => at(ms, 'usage', {
    usage: { promptTokens: totalTokens - 100, completionTokens: 100, totalTokens, cachedTokens: totalTokens - 200, reasoningTokens: 40, cost, model: 'deepseek/v4', provider: 'openrouter' },
    taskTokens: totalTokens, taskCost: cost,
  });
  const kinds = (segments: RunSegment[]) => segments.map((s) => (s.kind === 'steps' ? `steps:${s.tally.steps.length}` : s.kind === 'notice' ? `notice:${s.notice.kind}` : s.kind === 'reasoning' ? 'reasoning' : `text:${s.text}`));

  it('puts prose before the steps of the response that wrote it, though its message lands after they ran', () => {
    const segments = splitRuns([
      ask(0),
      turn(100), run(200, 'k1', 'cat /a.html'), done(210, 'k1'), said(220, ''),
      turn(300), run(400, 'k2', 'ss /a.css'), done(410, 'k2'), said(420, 'Now the stylesheet:'),
      at(500, 'task_complete'),
    ])[0].segments;
    expect(kinds(segments)).toEqual(['steps:1', 'text:Now the stylesheet:', 'steps:1']);
  });

  it('shows prose as it streams, where it started, and keeps one copy when the message lands', () => {
    const streaming = [
      ask(0),
      turn(100), run(200, 'k1', 'cat /a.html'), done(210, 'k1'), said(220, ''),
      turn(300), at(310, 'assistant_delta', { all: [{ text: 'Now the ' }, { text: 'stylesheet:' }] }),
      run(400, 'k2', 'ss /a.css'),
    ];
    expect(kinds(splitRuns(streaming)[0].segments)).toEqual(['steps:1', 'text:Now the stylesheet:', 'steps:1']);
    const landed = [...streaming, done(410, 'k2'), said(420, 'Now the stylesheet:\n\n'), at(500, 'task_complete')];
    expect(kinds(splitRuns(landed)[0].segments)).toEqual(['steps:1', 'text:Now the stylesheet:', 'steps:1']);
  });

  it('ends a group at a compaction, whose call is no group\'s', () => {
    const r = splitRuns([
      ask(0),
      turn(100), spent(150, 1_000, 0.001), run(200, 'k1', 'ss /a.css'), done(210, 'k1'), said(220, ''),
      // The provider adapter reports the same call again; it must not count twice.
      at(225, 'usage', { usage: { totalTokens: 999, cost: 9 }, cost: 9 }),
      at(230, 'conversation_message', { message: { role: 'tool', content: 'ok' } }),
      spent(1_230, 500, 0.0005), at(1_235, 'conversation_replaced', {}),
      at(1_240, 'compaction', { preCompactTokens: 40_000, postCompactEstimate: 20_000 }),
      turn(1_250), spent(1_300, 2_000, 0.002), run(1_400, 'k2', 'cat /b.html'), done(1_410, 'k2'), said(1_420, ''),
      at(1_500, 'task_complete'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['steps:1', 'notice:compaction', 'steps:1']);
    const [first, notice, second] = r.segments as [Group, RunSegment, Group];
    expect(notice).toEqual({ kind: 'notice', notice: { kind: 'compaction', before: 40_000, after: 20_000 } });
    expect(first.usage).toMatchObject({ calls: 1, totalTokens: 1_000 });
    expect(second.usage).toMatchObject({ calls: 1, totalTokens: 2_000 });
    // The run's line counts the compaction's call as well.
    expect(r.usage).toMatchObject({ calls: 3, totalTokens: 3_500, ms: 1_300 });
    expect(r.usage!.cost).toBeCloseTo(0.0035);
  });

  it('leaves a call made after the response landed, as the completion judge\'s, to the run\'s line alone', () => {
    const r = splitRuns([
      ask(0),
      turn(100), spent(150, 400, 0.0004), run(200, 'k1', 'status --task "Blue" --done "Made the header blue" --complete'), done(210, 'k1'), said(220, ''),
      spent(300, 1_000, 0.001),
      at(400, 'task_complete'),
    ])[0];
    expect((r.segments[0] as Group).usage).toMatchObject({ calls: 1, totalTokens: 400 });
    expect(r.usage).toMatchObject({ calls: 2, totalTokens: 1_400 });
  });

  it('leaves a call made before the first response, as the skill check\'s, to the run\'s line alone', () => {
    const r = splitRuns([
      ask(0), spent(50, 300, 0.0003),
      turn(100), spent(150, 400, 0.0004), run(200, 'k1', 'cat /a.html'), done(210, 'k1'), said(220, ''),
      at(400, 'task_complete'),
    ])[0];
    expect((r.segments[0] as Group).usage).toMatchObject({ calls: 1, totalTokens: 400 });
    expect(r.usage).toMatchObject({ calls: 2, totalTokens: 700 });
  });

  it('leaves the call of a response that wrote prose out of the steps that follow it', () => {
    const r = splitRuns([
      ask(0),
      turn(100), spent(150, 1_000, 0.001), run(200, 'k1', 'ss /a.css'), done(210, 'k1'), said(220, 'Writing the stylesheet.'),
      at(300, 'task_complete'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['text:Writing the stylesheet.', 'steps:1']);
    expect((r.segments[1] as Group).usage).toBeNull();
    expect(r.usage).toMatchObject({ calls: 1, totalTokens: 1_000 });
  });

  it('shows prose as it streams, before the response that writes it reports its call', () => {
    const r = splitRuns([ask(0), turn(100), at(2_000, 'assistant_delta', { all: [{ text: 'Looking at the page.' }] })])[0];
    expect(r.segments).toEqual([{ kind: 'text', text: 'Looking at the page.' }]);
    expect(r.usage).toBeNull();
  });

  it('puts a model switch before the steps of the response it switched for', () => {
    const r = splitRuns([
      ask(0),
      turn(100), run(200, 'k1', 'cat /a.html'), done(210, 'k1'), said(220, ''),
      turn(300), at(310, 'model_switched', { provider: 'openrouter', fromModel: 'a/x', toModel: 'b/y', reason: 'busy' }),
      run(400, 'k2', 'ss /a.css'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['steps:1', 'notice:limit', 'steps:1']);
    expect(r.segments[1]).toMatchObject({ notice: { kind: 'limit', data: { kind: 'switched', fromModel: 'a/x', toModel: 'b/y' } } });
  });

  it('shows a correction the harness sent the model as a notice, in order', () => {
    const r = splitRuns([
      ask(0),
      turn(100), run(200, 'k1', 'cat /a.html'), done(210, 'k1'), said(220, ''),
      at(230, 'conversation_message', { message: { role: 'user', content: 'Error: no such file', ui_metadata: { isSyntheticError: true } } }),
      turn(300), run(400, 'k2', 'cat /b.html'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['steps:1', 'notice:correction', 'steps:1']);
    expect(r.segments[1]).toMatchObject({ notice: { kind: 'correction', text: 'Error: no such file' } });
  });

  it('notes a retry only while the run is still waiting on it', () => {
    const waiting = splitRuns([ask(0), turn(100), at(150, 'retry', { provider: 'openrouter', status: 429 }), at(160, 'waiting')])[0];
    expect(waiting.segments.at(-1)).toMatchObject({ notice: { kind: 'limit', data: { kind: 'retrying', status: 429 } } });
    const answered = splitRuns([ask(0), turn(100), at(150, 'retry', { provider: 'openrouter', status: 429 }), run(200, 'k1', 'cat /a.html')])[0];
    expect(kinds(answered.segments)).toEqual(['steps:1']);
  });

  it('keeps the provider stop the run ended on, for its card', () => {
    const stop = at(150, 'api_stopped', { errorCategory: 'daily_limit', provider: 'openrouter' });
    const r = splitRuns([ask(0), turn(100), stop])[0];
    expect(r.stopped).toEqual({ id: stop.id, data: { errorCategory: 'daily_limit', provider: 'openrouter' } });
  });

  it('closes a finished run with its status --done when it wrote no closing prose', () => {
    const r = splitRuns([
      ask(0),
      turn(100), spent(150, 1_000, 0.001), run(200, 'k1', 'ss /a.css'), done(210, 'k1'), said(220, ''),
      turn(300), spent(350, 400, 0.0004), run(400, 'k2', 'cd / && build && status --task "Blue" --done "Made the header blue" --remaining "none" --complete'), done(410, 'k2'), said(420, ''),
      at(500, 'task_complete'),
      // Written after the run ended; its time is not the last response's.
      at(900, 'checkpoint_created', { checkpointId: 'cp_1' }),
    ])[0];
    expect(r.closing).toEqual({ text: 'Made the header blue', task: 'Blue', remaining: 'none' });
    // The response that ran status ran its tools in the group, so its call is the group's too.
    expect((r.segments[0] as Group).usage).toMatchObject({ calls: 2, totalTokens: 1_400 });
  });

  it('has no closing line when the run ended on prose, which is the closing message itself', () => {
    const r = splitRuns([
      ask(0),
      turn(100), run(200, 'k1', 'status --task "Blue" --done "Made the header blue" --complete'), done(210, 'k1'), said(220, ''),
      turn(300), said(320, 'The header is blue now.'),
      at(400, 'task_complete'),
    ])[0];
    expect(r.closing).toBeNull();
    expect(r.segments.at(-1)).toMatchObject({ kind: 'text', text: 'The header is blue now.' });
  });

  it('names the call the model is writing, from its streamed arguments, until it runs', () => {
    const opened = at(300, 'toolCalls', { toolCalls: [{ id: 'k2', function: { name: 'bash', arguments: '' } }] });
    const half = '{"command": "cat > /a.html << \'EOF\'\\n<!DOCTYPE html>\\n<html>';
    const first = at(310, 'tool_param_delta', { all: [{ toolId: 'k2', fragment: half.slice(0, 20) }] });
    const second = at(320, 'tool_param_delta', { all: [{ toolId: 'k2', fragment: half.slice(20) }] });
    const writing = splitRuns([ask(0), turn(100), run(200, 'k1', 'cat /b.html'), done(210, 'k1'), said(220, ''), turn(250), opened, first, second])[0];
    // A call's arguments can span two coalesced delta events; both count.
    expect(writing.forming).toEqual({ kind: 'write', path: '/a.html', lines: 2 });
    const running = splitRuns([ask(0), turn(250), opened, first, second, run(400, 'k2', 'cat > /a.html << \'EOF\'\n<html>')])[0];
    expect(running.forming).toBeNull();
    const ended = splitRuns([ask(0), turn(250), opened, first, second, at(400, 'stopped')])[0];
    expect(ended.forming).toBeNull();
  });

  it('carries the task and what remains with the closing line', () => {
    const r = splitRuns([
      ask(0), turn(100), run(200, 'k1', 'status --task "Make it blue" --done "Made the header blue" --remaining "the footer" --complete'), done(210, 'k1'), said(220, ''),
      at(300, 'task_complete'),
    ])[0];
    expect(r.closing).toMatchObject({ text: 'Made the header blue', task: 'Make it blue', remaining: 'the footer' });
  });

  it('keeps a group\'s own events, with the message whose calls it holds, for opening it', () => {
    const message = said(220, '');
    const r = splitRuns([ask(0), turn(100), run(200, 'k1', 'cat /a.html'), done(210, 'k1'), message])[0];
    const group = r.segments[0] as Extract<RunSegment, { kind: 'steps' }>;
    expect(group.events).toContain(message);
    expect(group.tally.steps[0].callIds).toEqual(['k1']);
  });

  const thinks = (ms: number, text: string) => at(ms, 'reasoning_delta', { text });

  it('gives the reasoning of a response that ran no tools its own place, before its prose', () => {
    const thought = thinks(120, 'The page has two headers.');
    const r = splitRuns([
      ask(0),
      turn(100), run(110, 'k1', 'cat /a.html'), done(115, 'k1'), said(118, ''),
      turn(119), thought, at(130, 'reasoning_complete'),
      at(140, 'assistant_delta', { all: [{ text: 'It has two headers.' }] }), said(150, 'It has two headers.'),
      at(200, 'task_complete'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['steps:1', 'reasoning', 'text:It has two headers.']);
    expect((r.segments[1] as Extract<RunSegment, { kind: 'reasoning' }>).events).toContain(thought);
    // Not also in the group before it.
    expect((r.segments[0] as Extract<RunSegment, { kind: 'steps' }>).events).not.toContain(thought);
  });

  it('leaves the reasoning of a response that ran tools in that response\'s group', () => {
    const thought = thinks(120, 'Start with the stylesheet.');
    const r = splitRuns([
      ask(0),
      turn(100), thought, at(130, 'assistant_delta', { all: [{ text: 'Now the stylesheet:' }] }),
      run(200, 'k1', 'ss /a.css'), done(210, 'k1'), said(220, 'Now the stylesheet:'),
      at(300, 'task_complete'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['text:Now the stylesheet:', 'steps:1']);
    expect((r.segments[1] as Extract<RunSegment, { kind: 'steps' }>).events).toContain(thought);
  });

  it('counts the call of a response that only reasoned toward the run alone', () => {
    const r = splitRuns([ask(0), turn(100), spent(110, 1_000, 0.001), thinks(120, 'Nothing to change.'), said(130, ''), at(200, 'task_complete')])[0];
    expect(kinds(r.segments)).toEqual(['reasoning']);
    expect(r.usage).toMatchObject({ calls: 1, totalTokens: 1_000 });
  });

  it('keeps the steps before a response that only reasoned ahead of its reasoning', () => {
    // A response stopped mid-thought, or one that answered with nothing: its reasoning comes after
    // the steps of the responses before it, not above them.
    const r = splitRuns([
      ask(0),
      turn(100), run(110, 'k1', 'cat /a.html'), done(115, 'k1'), said(120, ''),
      turn(200), thinks(210, 'head with several files should print headers.'), said(220, ''),
      at(300, 'stopped', { reason: 'user' }),
    ])[0];
    expect(kinds(r.segments)).toEqual(['steps:1', 'reasoning']);
  });

  it('carries the question the run ended on, with the options it offered', () => {
    const r = splitRuns([
      ask(0), turn(100), run(200, 'k1', 'ask --prompt "Which look?" "Bold" "Soft"'),
      at(205, 'ask', { prompt: 'Which look?', options: ['Bold', 'Soft', ''] }),
      done(210, 'k1'), said(220, ''), at(300, 'task_complete'),
    ])[0];
    expect(r.ask).toEqual({ prompt: 'Which look?', options: ['Bold', 'Soft'] });
    expect(r.tally.steps[0].kind).toBe('ask');
    expect(splitRuns([ask(0), at(100, 'ask', { options: ['Bold', 'Soft'] })])[0].ask).toEqual({ prompt: null, options: ['Bold', 'Soft'] });
    expect(splitRuns([ask(0), turn(100)])[0].ask).toBeNull();
  });

  it('keeps the error the run ended on, in its own words', () => {
    const r = splitRuns([ask(0), turn(100), at(150, 'error', { message: '401 Unauthorized: Invalid API key', stack: 'Error: 401\n    at call' })])[0];
    expect(r.error).toEqual({ message: '401 Unauthorized: Invalid API key', stack: 'Error: 401\n    at call' });
    expect(r.tally.status).toBe('failed');
    expect(splitRuns([ask(0), turn(100), at(150, 'error', {})])[0].error).toEqual({ message: '', stack: '' });
  });

  it('takes a failed run\'s reason from its completion when nothing threw', () => {
    const quiet = splitRuns([ask(0), turn(100), at(150, 'task_complete', { result: 'failed', error: 'Exited after 3 nudge attempts without status' })])[0];
    expect(quiet.error).toEqual({ message: 'Exited after 3 nudge attempts without status', stack: '' });
    const thrown = splitRuns([ask(0), turn(100), at(150, 'error', { message: 'boom', stack: 'at x' }), at(160, 'task_complete', { result: 'failed', error: 'boom' })])[0];
    expect(thrown.error).toEqual({ message: 'boom', stack: 'at x' });
  });

  it('keeps the gated command a paused run waits on after the pause ends it', () => {
    const r = splitRuns([
      ask(0), turn(100), at(150, 'approval_required', { gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)' }),
      at(160, 'task_complete', { result: 'success', exitReason: 'awaiting_user' }),
    ])[0];
    expect(r.approval).toEqual({ gateKey: 'rm', capabilityLabel: 'rm / rmdir (delete)', command: null });
  });

  it('shows an interview\'s completion check as a notice, after the status call that ran it', () => {
    const handoff = { label: 'Build it', prompt: 'Build the site from the brief', mode: 'code' };
    const r = splitRuns([
      ask(0), turn(100), run(200, 'k1', 'status --task "Brief" --done "Captured the brief" --complete'), done(210, 'k1'), said(220, ''),
      at(230, 'interview_gate', { complete: true, items: [], handoff }),
      at(300, 'task_complete'),
    ])[0];
    expect(kinds(r.segments)).toEqual(['steps:1', 'notice:interview']);
    expect(r.segments[1]).toMatchObject({ notice: { kind: 'interview', gate: { complete: true, handoff } } });
  });
});
