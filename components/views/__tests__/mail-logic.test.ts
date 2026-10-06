import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import type { QueueStats } from '@/lib/mail/queue-stats';
import { QUIET_PERIOD_MINUTES } from '@/lib/review/digest';
import {
  buildSmtpBody,
  classifyTestResponse,
  describeWorkspaceSending,
  formatAge,
  formatSender,
  instanceCanSend,
  instanceToggleState,
  parseFromAddress,
  parsePortInput,
  presentQueue,
  presentTestResult,
  workspaceCanSend,
  type SmtpForm,
} from '../mail-logic';

/**
 * The English the app actually ships, not a copy of it.
 *
 * `presentTestResult` takes its copy from the caller, so the assertions below read en.json. That
 * keeps the rules this module exists to enforce — never claim a message was delivered, never
 * describe a blocked host as a connection failure — checked against the words a reader sees.
 */
const mailT = createTranslator({ locale: 'en', messages: en, namespace: 'mail' });
const queueT = createTranslator({ locale: 'en', messages: en, namespace: 'mail.queueSummary' });

/**
 * The Mail page's logic, tested where it lives: as plain functions.
 *
 * The page itself is a `PageShell` over two `Section`s and some fetches, and the layers underneath
 * it — the settings readers, the transport resolution, the host guard, the seven routes — all have
 * their own tests. What is worth pinning here is the wording, because two sentences on this page can
 * be wrong in a way that costs somebody a client: presenting a refused host as a connection failure,
 * and describing a queued message as delivered.
 */

function stats(over: Partial<QueueStats> = {}): QueueStats {
  return {
    pending: 0,
    failing: 0,
    abandoned: 0,
    oldestPendingAt: null,
    oldestPendingAgeSeconds: null,
    ...over,
  };
}

const BLOCKED_ERROR =
  'That SMTP host is not allowed. A workspace mail server has to be reachable at a public address.';

describe('classifyTestResponse', () => {
  it('reads the four outcomes off the routes as they actually answer', () => {
    expect(classifyTestResponse(200, null)).toBe('sent');
    expect(classifyTestResponse(400, BLOCKED_ERROR)).toBe('blocked');
    expect(
      classifyTestResponse(400, 'No mail server is configured for this workspace or for the instance.')
    ).toBe('unconfigured');
    expect(classifyTestResponse(502, '535 5.7.8 Authentication credentials invalid')).toBe('refused');
  });

  it('recognises the admin route’s shorter blocked message too', () => {
    expect(classifyTestResponse(400, 'That SMTP host is not allowed.')).toBe('blocked');
  });

  it('falls back to unconfigured for an unrecognised 400, never to a connection failure', () => {
    expect(classifyTestResponse(400, 'something else entirely')).toBe('unconfigured');
    expect(classifyTestResponse(400, null)).toBe('unconfigured');
  });

  it('separates the auth failures from a mail failure', () => {
    expect(classifyTestResponse(401, 'Unauthorized')).toBe('unauthorized');
    expect(classifyTestResponse(403, 'Insufficient workspace permissions')).toBe('forbidden');
    expect(classifyTestResponse(500, 'Failed to send test message')).toBe('error');
    expect(classifyTestResponse(0, null)).toBe('error');
  });
});

describe('presentTestResult', () => {
  it('says a sent test was accepted, not that it arrived', () => {
    const result = presentTestResult(mailT, { status: 200, error: null, recipient: 'otto@acme.studio' });

    expect(result.tone).toBe('success');
    expect(result.detail).toContain('otto@acme.studio');
    expect(result.detail).toMatch(/accepted/i);
    expect(result.detail).not.toMatch(/delivered/i);
  });

  it('presents a blocked host as a refusal, with nothing said about connecting', () => {
    const result = presentTestResult(mailT, { status: 400, error: BLOCKED_ERROR, recipient: null });

    expect(result.outcome).toBe('blocked');
    expect(result.tone).toBe('blocked');
    expect(result.detail).toMatch(/public address/);
    expect(result.detail).toMatch(/not a connection failure/i);
    // Nothing about what happened when the host was dialled, because it never was.
    expect(result.detail).not.toMatch(/timed out|refused the connection|unreachable/i);
    expect(result.serverError).toBeNull();
  });

  it('gives the four outcomes four different presentations', () => {
    const outcomes = [
      presentTestResult(mailT, { status: 200, error: null, recipient: null }),
      presentTestResult(mailT, { status: 400, error: 'No mail server is configured.', recipient: null }),
      presentTestResult(mailT, { status: 400, error: BLOCKED_ERROR, recipient: null }),
      presentTestResult(mailT, { status: 502, error: '535 bad credentials', recipient: null }),
    ];

    expect(new Set(outcomes.map((o) => o.tone)).size).toBe(4);
    expect(new Set(outcomes.map((o) => o.title)).size).toBe(4);
  });

  it('carries a refusal back in the mail server’s own words', () => {
    const result = presentTestResult(mailT, {
      status: 502,
      error: '535 5.7.8 Authentication credentials invalid',
      recipient: 'otto@acme.studio',
    });

    expect(result.tone).toBe('failure');
    expect(result.serverError).toBe('535 5.7.8 Authentication credentials invalid');
  });

  it('uses the route’s own wording for an unconfigured tier', () => {
    const result = presentTestResult(mailT, {
      status: 400,
      error: 'Instance mail is not configured. Set an SMTP server and a From address first.',
      recipient: null,
    });

    expect(result.tone).toBe('holding');
    expect(result.detail).toBe(
      'Instance mail is not configured. Set an SMTP server and a From address first.'
    );
  });
});

describe('presentQueue', () => {
  it('never calls anything delivered, in any state', () => {
    const cases = [
      presentQueue(queueT, stats(), { scope: 'workspace' }),
      presentQueue(queueT, stats({ pending: 2, oldestPendingAgeSeconds: 200 }), { scope: 'workspace' }),
      presentQueue(queueT, stats({ pending: 6, failing: 2, abandoned: 1 }), { scope: 'instance' }),
    ];

    for (const queue of cases) {
      const text = [queue.headline, ...queue.lines].join(' ');
      expect(text).not.toMatch(/deliver/i);
      expect(text).not.toMatch(/\bsent to\b/i);
    }
  });

  it('always closes by saying what leaving the queue actually means', () => {
    const queue = presentQueue(queueT, stats({ pending: 3 }), { scope: 'workspace' });

    expect(queue.lines[queue.lines.length - 1]).toMatch(/accepted/i);
    expect(queue.lines[queue.lines.length - 1]).toMatch(/not the same as it reaching a person/i);
  });

  it('promises nothing about mail that was never composed', () => {
    // The queue is only shown where a server can send, and a tier that cannot send composes
    // nothing. Neither half of the old reassurance — that digests keep being collected, and that
    // they go out once a server appears — describes anything that still happens.
    const queue = presentQueue(queueT, stats({ pending: 2, oldestPendingAgeSeconds: 400 }), {
      scope: 'workspace',
    });

    expect(queue.headline).toBe('Queue — 2 waiting');
    const text = queue.lines.join(' ');
    expect(text).not.toMatch(/still being collected|nothing is lost/i);
    expect(text).toMatch(/waiting 6 minutes/);
  });

  it('counts waiting, failing and abandoned separately', () => {
    const queue = presentQueue(queueT, stats({ pending: 6, failing: 2, abandoned: 3 }), {
      scope: 'instance',
    });

    // `failing` is a subset of `pending`, so the headline must not read as 6 + 2 + 3.
    expect(queue.headline).toBe('Queue — 6 waiting, 2 of them failing, 3 given up');
    expect(queue.lines[0]).toMatch(/Across every workspace/);
    expect(queue.lines.join(' ')).toMatch(/3 ran out of attempts/);
  });

  it('reports an empty queue as empty', () => {
    const queue = presentQueue(queueT, stats(), { scope: 'workspace' });

    expect(queue.headline).toBe('Queue — empty');
    expect(queue.lines.join(' ')).toMatch(/Nothing is waiting/);
  });
});

describe('formatAge', () => {
  it('rounds down to a unit a person reads', () => {
    expect(formatAge(null, queueT)).toBe('a moment');
    expect(formatAge(30, queueT)).toBe('less than a minute');
    expect(formatAge(60, queueT)).toBe('1 minute');
    expect(formatAge(200, queueT)).toBe('3 minutes');
    expect(formatAge(3600, queueT)).toBe('1 hour');
    expect(formatAge(7200, queueT)).toBe('2 hours');
    expect(formatAge(60 * 60 * 72, queueT)).toBe('3 days');
  });
});

describe('parseFromAddress / formatSender', () => {
  it('splits both spellings of a From', () => {
    expect(parseFromAddress('review@acme.studio')).toEqual({
      address: 'review@acme.studio',
      name: null,
    });
    expect(parseFromAddress('Acme Studio <review@acme.studio>')).toEqual({
      address: 'review@acme.studio',
      name: 'Acme Studio',
    });
    expect(parseFromAddress('"Acme, Studio" <review@acme.studio>')).toEqual({
      address: 'review@acme.studio',
      name: 'Acme, Studio',
    });
  });

  it('puts the display name in front, the way the transport does', () => {
    expect(formatSender('Acme Ltd <review@acme.studio>', 'Acme Studio')).toBe(
      'Acme Studio <review@acme.studio>'
    );
    expect(formatSender('review@acme.studio', null)).toBe('review@acme.studio');
    expect(formatSender(null, 'Acme Studio')).toBeNull();
  });
});

describe('instanceToggleState', () => {
  /**
   * The switch is drawn from what the instance is doing, not from the row behind it, because the row
   * cannot default off: an instance provisioned from SMTP_* never writes one, and reading absence as
   * off would stop every workspace's mail silently. These three cases are the whole of that.
   */
  it('reads off when there is no server to offer', () => {
    // `enabled` is true here because nothing has ever written the row. Nothing is being offered all
    // the same, and drawing the switch on would say mail was on its way when none can be sent.
    expect(instanceToggleState({ enabled: true, configured: false })).toBe(false);
  });

  it('reads on for a working server with no switch row written', () => {
    // The provisioned instance. Drawing this off would misreport a server that is offering itself.
    expect(instanceToggleState({ enabled: true, configured: true })).toBe(true);
  });

  it('reads off for a working server the operator has withdrawn', () => {
    expect(instanceToggleState({ enabled: false, configured: true })).toBe(false);
  });
});

/**
 * What the page draws a test button and a queue beside.
 *
 * Both are controls that act on a saved server: the test sends through it, the queue is what is
 * waiting for it. With no server there is nothing for either to do, and the previous pass hung them
 * on the offer switch instead — which showed both on an instance that had never been configured at
 * all.
 */
describe('instanceCanSend', () => {
  it('follows the server, not the offer', () => {
    // The load-bearing case: an operator who has withdrawn the offer still relays their own mail
    // through this server, so both controls still do something.
    expect(instanceCanSend({ enabled: false, configured: true })).toBe(true);
  });

  it('is false when there is no server behind the switch', () => {
    expect(instanceCanSend({ enabled: true, configured: false })).toBe(false);
    expect(instanceCanSend({ enabled: false, configured: false })).toBe(false);
  });
});

describe('workspaceCanSend', () => {
  const base = { enabled: true, mode: 'own' as const, host: null, from: null };
  const instance = (state: 'available' | 'unavailable' | 'unknown') => ({ state, from: null });

  it('needs a host and an address of its own in own mode', () => {
    const own = { ...base, host: 'smtp.acmestudio.com', from: 'review@acmestudio.com' };

    expect(workspaceCanSend({ ...own, instance: instance('unavailable') })).toBe(true);
    expect(workspaceCanSend({ ...own, from: null, instance: instance('available') })).toBe(false);
    expect(workspaceCanSend({ ...own, host: null, instance: instance('available') })).toBe(false);
  });

  it('needs the instance to be offering its server in instance mode', () => {
    const relaying = { ...base, mode: 'instance' as const };

    expect(workspaceCanSend({ ...relaying, instance: instance('available') })).toBe(true);
    expect(workspaceCanSend({ ...relaying, instance: instance('unavailable') })).toBe(false);
  });

  it('waits rather than guessing before the instance has answered', () => {
    // A button that turns out to have nothing behind it is worse than one that arrives a moment
    // later.
    expect(
      workspaceCanSend({ ...base, mode: 'instance', instance: instance('unknown') })
    ).toBe(false);
  });

  it('is false for a switched-off workspace, however complete its server', () => {
    // Off relays through neither tier, so a test send would only report that nothing is configured.
    expect(
      workspaceCanSend({
        enabled: false,
        mode: 'own',
        host: 'smtp.acmestudio.com',
        from: 'review@acmestudio.com',
        instance: instance('available'),
      })
    ).toBe(false);
  });
});

describe('describeWorkspaceSending', () => {
  const instance = (state: 'available' | 'unavailable' | 'unknown', from: string | null = null) =>
    ({ state, from }) as const;

  it('never promises that what was missed will be sent later', () => {
    // The three states in which nothing is going out. None of them accumulates mail any more, so
    // none of them may offer a backlog: turning a tier on starts from that moment.
    const notSending = [
      describeWorkspaceSending(mailT, {
        enabled: false,
        mode: 'own',
        displayName: null,
        host: 'smtp.acmestudio.com',
        from: 'review@acmestudio.com',
        instance: instance('available'),
      }),
      describeWorkspaceSending(mailT, {
        enabled: true,
        mode: 'own',
        displayName: null,
        host: null,
        from: null,
        instance: instance('unknown'),
      }),
      describeWorkspaceSending(mailT, {
        enabled: true,
        mode: 'instance',
        displayName: null,
        host: null,
        from: null,
        instance: instance('unavailable'),
      }),
    ];

    for (const result of notSending) {
      // The badge word matters as much as the sentence: 'Holding' said mail was being kept for
      // later while the sentence beside it said the opposite, which is the contradiction a reader
      // actually noticed on the page.
      expect(result.state).toBe('not-sending');
      expect(result.sentence).not.toMatch(/nothing is lost|held|as soon as|will send|catch up/i);
    }
  });

  it('says a switched-off workspace is not sending, and names no server', () => {
    // A complete own-server configuration that is switched off is not a sending arrangement, and
    // naming the server it would have used would describe one that is not in effect.
    const result = describeWorkspaceSending(mailT, {
      enabled: false,
      mode: 'own',
      displayName: null,
      host: 'smtp.acmestudio.com',
      from: 'Acme Studio <review@acmestudio.com>',
      instance: instance('available', 'OSW Studio <review@oswstudio.com>'),
    });

    expect(result.state).toBe('not-sending');
    expect(result.sentence).toMatch(/sending is off/i);
    expect(result.sentence).toMatch(/nothing is emailed/i);
    expect(result.sentence).toMatch(/comments still land in the review/i);
    // The watermark rule — that turning a tier back on starts from that moment — is stated once, in
    // the page footnote. A status line that repeated it made the page say the same thing twice.
    expect(result.sentence).not.toMatch(/starts from that moment/i);
    expect(result.sentence).not.toContain('smtp.acmestudio.com');
    expect(result.sentence).not.toMatch(/@/);
  });

  it('names the sender when the workspace runs its own server', () => {
    const result = describeWorkspaceSending(mailT, {
      enabled: true,
      mode: 'own',
      displayName: null,
      host: 'smtp.acmestudio.com',
      from: 'Acme Studio <review@acmestudio.com>',
      instance: instance('unknown'),
    });

    expect(result.state).toBe('sending');
    expect(result.sentence).toContain('Acme Studio <review@acmestudio.com>');
    expect(result.sentence).toContain('smtp.acmestudio.com');
  });

  it('says what an own server is still missing rather than claiming it sends', () => {
    const result = describeWorkspaceSending(mailT, {
      enabled: true,
      mode: 'own',
      displayName: null,
      host: 'smtp.acmestudio.com',
      from: null,
      instance: instance('unknown'),
    });

    expect(result.state).toBe('not-sending');
    expect(result.sentence).toMatch(/still needs a From address/);
    expect(result.sentence).toMatch(/Comments are still collected in the review/);
    // What happens to mail while a tier has no server is the footnote's to say, not this line's.
    expect(result.sentence).not.toMatch(/nothing is composed|starts from then/i);
  });

  it('is explicit that nothing sends when the instance has no server', () => {
    const result = describeWorkspaceSending(mailT, {
      enabled: true,
      mode: 'instance',
      displayName: 'Acme Studio',
      host: null,
      from: null,
      instance: instance('unavailable'),
    });

    expect(result.state).toBe('not-sending');
    expect(result.sentence).toMatch(/No mail is going out/);
    // Both halves of why, so an owner is not left to guess which tier to fix.
    expect(result.sentence).toMatch(/no mail server to relay through/);
    expect(result.sentence).toMatch(/has not set up its own/);
    expect(result.sentence).not.toMatch(/nothing is composed|starts from then/i);
  });

  it('uses the instance address, with the workspace’s name in front of it', () => {
    const result = describeWorkspaceSending(mailT, {
      enabled: true,
      mode: 'instance',
      displayName: 'Acme Studio',
      host: null,
      from: 'OSW Studio <review@oswstudio.com>',
      instance: instance('available', 'OSW Studio <review@oswstudio.com>'),
    });

    expect(result.state).toBe('sending');
    expect(result.sentence).toContain('Acme Studio <review@oswstudio.com>');
  });

  it('says a workspace is sending when the instance can, without naming the address', () => {
    // A non-admin owner is never given the instance's From, so there is no sender to name — but the
    // workspace response carries whether the instance will relay, and that settles the state. Saying
    // `unknown` here withheld a fact the page had been told.
    const result = describeWorkspaceSending(mailT, {
      enabled: true,
      mode: 'instance',
      displayName: 'Acme Studio',
      host: null,
      from: null,
      instance: instance('available'),
    });

    expect(result.state).toBe('sending');
    expect(result.sentence).toMatch(/instance mail server/);
    expect(result.sentence).toContain('Acme Studio');
    // Nothing of the instance's own tier: not its host, not its address.
    expect(result.sentence).not.toMatch(/@/);
  });

  it('claims neither way for an owner who cannot read the instance tier', () => {
    const result = describeWorkspaceSending(mailT, {
      enabled: true,
      mode: 'instance',
      displayName: 'Acme Studio',
      host: null,
      from: null,
      instance: instance('unknown'),
    });

    expect(result.state).toBe('unknown');
    expect(result.sentence).toMatch(/instance mail server/);
    expect(result.sentence).not.toMatch(/No mail is going out/);
  });
});

describe('parsePortInput / buildSmtpBody', () => {
  const form = (over: Partial<SmtpForm> = {}): SmtpForm => ({
    host: 'smtp.acme.studio',
    port: '587',
    secure: 'starttls',
    user: 'acme',
    from: 'review@acme.studio',
    ...over,
  });

  it('treats an empty port as no port, and refuses a nonsense one', () => {
    expect(parsePortInput('')).toEqual({ port: null });
    expect(parsePortInput('  587 ')).toEqual({ port: 587 });
    expect(parsePortInput('0')).toHaveProperty('error');
    expect(parsePortInput('70000')).toHaveProperty('error');
    expect(parsePortInput('half')).toHaveProperty('error');
  });

  it('sends every field so that emptying one clears it', () => {
    const result = buildSmtpBody(form({ user: '  ' }), undefined);

    expect(result).toEqual({
      body: {
        host: 'smtp.acme.studio',
        port: 587,
        secure: 'starttls',
        user: null,
        from: 'review@acme.studio',
      },
    });
  });

  it('leaves the stored password alone unless the person touched it', () => {
    expect('password' in (buildSmtpBody(form(), undefined) as { body: Record<string, unknown> }).body).toBe(
      false
    );
    expect((buildSmtpBody(form(), 'hunter2') as { body: Record<string, unknown> }).body.password).toBe(
      'hunter2'
    );
    expect((buildSmtpBody(form(), null) as { body: Record<string, unknown> }).body.password).toBeNull();
  });

  it('refuses to build a body around an impossible port', () => {
    expect(buildSmtpBody(form({ port: '-1' }), undefined)).toHaveProperty('error');
  });
});

describe('mail wording edges', () => {
  it('counts up to two days in hours', () => {
    expect(formatAge(30 * 3600, queueT)).toBe(queueT('ageHours', { count: 30 }));
    expect(formatAge(48 * 3600, queueT)).toBe(queueT('ageDays', { count: 2 }));
  });

  it('does not say nothing is waiting while given-up mail is on record', () => {
    const { lines } = presentQueue(queueT, stats({ abandoned: 2 }), { scope: 'workspace' });
    expect(lines).not.toContain(queueT('nothingWaiting', { minutes: QUIET_PERIOD_MINUTES }));
    // The empty case does say it, so the line compared against is the real one.
    expect(presentQueue(queueT, stats(), { scope: 'workspace' }).lines).toContain(queueT('nothingWaiting', { minutes: QUIET_PERIOD_MINUTES }));
  });

  it('explains failing mail when some is failing', () => {
    const { lines } = presentQueue(queueT, stats({ pending: 3, failing: 1, oldestPendingAgeSeconds: 120 }), { scope: 'workspace' });
    expect(lines).toContain(queueT('failingHint'));
  });

  it('names an own server\'s sender with its display name', () => {
    const result = describeWorkspaceSending(mailT, {
      enabled: true, mode: 'own', displayName: 'Acme Studio',
      host: 'smtp.acme.studio', from: 'review@acme.studio', instance: { state: 'unknown', from: null },
    });
    expect(result.sentence).toContain(formatSender('review@acme.studio', 'Acme Studio')!);
    expect(result.sentence).toContain('Acme Studio');
  });

  it('keeps the route\'s own words for a forbidden or failed test', () => {
    expect(presentTestResult(mailT, { status: 403, error: 'Only owners can test.', recipient: null }).detail).toBe('Only owners can test.');
    expect(presentTestResult(mailT, { status: 500, error: 'Database locked', recipient: null }).detail).toBe('Database locked');
  });
});
