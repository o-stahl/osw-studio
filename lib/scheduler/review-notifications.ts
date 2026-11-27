/**
 * The sweep that turns owed review digests into queued mail.
 *
 * Composition decides (lib/review/digest.ts); this commits. Nothing here touches the network: a
 * finished message goes into the outbox and the pass ends, and delivery drains it on its own
 * schedule.
 *
 * Whether anything is composed is decided here, by two gates. The deployment's own Email
 * notifications switch is the first; whether the workspace's mail is switched on and has a server
 * behind it is the second, and the difference between them is that the second one advances every
 * recipient's watermark on the way past. A channel that is closed does not keep a backlog to
 * release when it opens.
 *
 * Two more things shape the code more than the rest.
 *
 * A review database is *created* by opening it, `getReviewDatabaseConnection` runs `ensureDir` and
 * `new Database(...)`. A task that iterated every deployment and opened one would leave an empty
 * review.sqlite in the directory of every deployment on the instance, including the ones whose
 * owner never enabled review. So the deployment record is read first and decides whether this
 * deployment is in scope at all.
 *
 * And the watermark advance has to be tied to the outbox insert. They live in different SQLite
 * files, so one transaction over both is not available; what is available is running the insert
 * inside the review database's transaction, which is the direction that matters, see `commit`.
 */

import type { SchedulerTask } from './types';
import type { OwedMessage, SkippedDigest } from '@/lib/review/digest';
import type { ReviewComment, ReviewParticipant } from '@/lib/vfs/adapters/review-database';
import { appUrl as studioUrl } from '@/lib/web/site-origin';

export function createReviewNotificationTask(): SchedulerTask {
  return {
    type: 'review-notifications',
    execute: runReviewNotifications,
    enabled: true,
  };
}

/**
 * Where a recipient is sent to read the comments they were told about.
 *
 * A client gets the review copy, which is the only page they can reach without an account. A team
 * member gets their workspace's deployments page, where the Review panel lives; without a routing
 * row there is no workspace to name, and `/admin` is the redirect that finds their default one.
 */
function destinationUrl(appUrl: string, deploymentId: string, workspaceId: string | null, kind: OwedMessage['recipientKind']): string {
  if (kind === 'participant') return `${appUrl}/review/${deploymentId}`;
  return workspaceId ? `${appUrl}/w/${workspaceId}/deployments` : `${appUrl}/admin`;
}

async function runReviewNotifications(): Promise<void> {
  try {
    const { listDeploymentIds } = await import('@/lib/vfs/adapters/sqlite-connection');
    const deploymentIds = listDeploymentIds();

    for (const deploymentId of deploymentIds) {
      try {
        await notifyDeployment(deploymentId);
      } catch (err) {
        // One deployment's failure must not end the sweep, the next one may be a different
        // workspace entirely. Ids only: a review database holds private feedback and addresses.
        console.error(`[ReviewNotifications] Failed for deployment ${deploymentId}:`, err);
      }
    }
  } catch (err) {
    // Nothing in a notification pass is worth taking the scheduler down for.
    console.error('[ReviewNotifications] Sweep failed:', err);
  }
}

async function notifyDeployment(deploymentId: string): Promise<void> {
  const { resolveDeployment } = await import('@/lib/vfs/adapters/deployment-adapter');
  const resolved = await resolveDeployment(deploymentId);

  // The gate. Read from the deployment record, before anything that could create a file under this
  // deployment's directory.
  const review = resolved?.deployment.review;
  if (!resolved || !review?.enabled || !review.notifyByEmail) return;

  const { ReviewDatabase } = await import('@/lib/vfs/adapters/review-database');
  const db = new ReviewDatabase(deploymentId);
  db.init();

  // The whole list rather than `listCommentsSince`, which would be the cheaper read but cannot be
  // reached from here: its argument is the recipients' watermarks, and the recipients are
  // discovered *from* the comments, a participant who has never been notified has no state row to
  // bound the read by. The older comments are needed regardless, because a reply to a month-old
  // comment can only find out whose thread it is in by looking at that thread. Per-recipient
  // filtering happens in composeDigests, which is where it is tested.
  const comments = db.listComments();
  if (comments.length === 0) return;

  const participants = collectParticipants(db, comments);
  const members = await collectTeamMembers(resolved.workspaceId);

  // Each recipient's stored state is read once and feeds both the watermark map and, for a team
  // member, the mute flag on their recipient entry.
  const watermarks = new Map<string, { at: string; muted: boolean }>();
  const readState = (kind: 'participant' | 'user', id: string): boolean => {
    const state = db.getNotificationState(kind, id);
    if (!state) return false;
    watermarks.set(`${kind}:${id}`, { at: state.lastNotifiedAt ?? '', muted: state.muted });
    return state.muted;
  };

  for (const participant of participants) readState('participant', participant.id);
  const teamRecipients = members.map((member) => ({
    userId: member.userId,
    email: member.email,
    muted: readState('user', member.userId),
  }));

  const { composeDigests, skipDigests } = await import('@/lib/review/digest');
  const digestInput = {
    now: Date.now(),
    comments,
    participants,
    teamRecipients,
    watermarks,
  };

  // The second gate, and the one that decides whether anything is written at all. A tier switched
  // off, the workspace's own switch, the instance's offer to the workspaces relaying through it, or
  // a server removed from under either, closes the channel, and a closed channel composes nothing
  // and remembers nothing. Every recipient is brought up to date as though they had been told, so
  // switching the tier back on starts from that moment instead of releasing a month of digests at a
  // client in one volley.
  const { isMailSending } = await import('@/lib/mail/transport');
  if (!isMailSending(resolved.workspaceId)) {
    markSkipped(db, comments, skipDigests(digestInput));
    return;
  }

  const owed = composeDigests(digestInput);
  if (owed.length === 0) return;

  await queueDigests(deploymentId, resolved.workspaceId, resolved.deployment.name, db, comments, owed);
}

/**
 * Move the watermarks on for digests nobody will be sent.
 *
 * No outbox write to pair this with, so it needs none of `queueDigests`' transaction: there is only
 * one statement per recipient and nothing that could leave them inconsistent with each other. A pass
 * interrupted half way through simply advances the rest on the next sweep, which, with nothing
 * being sent either way, is the same outcome.
 */
function markSkipped(
  db: {
    setNotificationState(
      kind: 'participant' | 'user',
      id: string,
      state: { lastNotifiedAt: string | null; lastNotifiedCommentId: string | null }
    ): void;
  },
  comments: ReviewComment[],
  skipped: SkippedDigest[]
): void {
  const byId = new Map(comments.map((comment) => [comment.id, comment]));

  for (const entry of skipped) {
    const through = byId.get(entry.throughCommentId);
    if (!through) continue;

    db.setNotificationState(entry.recipientKind, entry.recipientId, {
      lastNotifiedAt: through.createdAt,
      lastNotifiedCommentId: through.id,
    });
  }
}

/** The participant rows behind the comments. Anyone with no row cannot be a recipient. */
function collectParticipants(
  db: { getParticipant(id: string): ReviewParticipant | null },
  comments: ReviewComment[]
): ReviewParticipant[] {
  const ids = [...new Set(comments.map((comment) => comment.participantId))];
  return ids
    .map((id) => db.getParticipant(id))
    .filter((participant): participant is ReviewParticipant => participant !== null);
}

/**
 * The workspace members who should hear about client feedback.
 *
 * `viewer` is left out: they can read the review but cannot act on it, and a digest is a request to
 * do something. A deployment with no routing row has no workspace to enumerate, the legacy
 * single-user layout, and simply has no team recipients.
 */
async function collectTeamMembers(
  workspaceId: string | null
): Promise<Array<{ userId: string; email: string }>> {
  if (!workspaceId) return [];

  const { listWorkspaceMembers } = await import('@/lib/auth/system-database');
  return listWorkspaceMembers(workspaceId)
    .filter((member) => member.role === 'owner' || member.role === 'editor')
    .filter((member) => Boolean(member.email))
    .map((member) => ({ userId: member.userId, email: member.email }));
}

async function queueDigests(
  deploymentId: string,
  workspaceId: string | null,
  deploymentName: string,
  db: {
    setNotificationState(
      kind: 'participant' | 'user',
      id: string,
      state: { lastNotifiedAt: string | null; lastNotifiedCommentId: string | null }
    ): void;
  },
  comments: ReviewComment[],
  owed: OwedMessage[]
): Promise<void> {
  const { getReviewDatabaseConnection } = await import('@/lib/vfs/adapters/sqlite-connection');
  const { enqueueEmail } = await import('@/lib/mail/outbox');
  const { renderDigest } = await import('@/lib/review/digest-render');
  const { createUnsubscribeToken } = await import('@/lib/review/unsubscribe-token');

  const appUrl = studioUrl();
  const byId = new Map(comments.map((comment) => [comment.id, comment]));
  // Already open and cached by deployment id, so this is the same handle the ReviewDatabase writes
  // through, which is what lets a transaction started here cover its writes.
  const connection = getReviewDatabaseConnection(deploymentId);

  for (const message of owed) {
    const owedComments = message.commentIds
      .map((id) => byId.get(id))
      .filter((comment): comment is ReviewComment => comment !== undefined);
    if (owedComments.length === 0) continue;

    const through = byId.get(message.throughCommentId);
    if (!through) continue;

    const parents = [
      ...new Set(
        owedComments
          .map((comment) => comment.parentId)
          .filter((parentId): parentId is string => parentId !== null)
      ),
    ]
      .map((parentId) => byId.get(parentId))
      .filter((comment): comment is ReviewComment => comment !== undefined);

    const token = createUnsubscribeToken(
      message.recipientKind,
      message.recipientId,
      deploymentId
    );
    const optOutUrl =
      `${appUrl}/review/${deploymentId}/unsubscribe` +
      `?kind=${message.recipientKind}` +
      `&id=${encodeURIComponent(message.recipientId)}` +
      `&token=${token}`;

    const rendered = renderDigest({
      message,
      deploymentName,
      comments: owedComments,
      parents,
      destinationUrl: destinationUrl(appUrl, deploymentId, workspaceId, message.recipientKind),
      optOutUrl,
    });

    /**
     * The queue and the watermark, as close to one write as two databases allow.
     *
     * The outbox is in the system database and the watermark in this deployment's review database.
     * SQLite can commit across attached databases atomically, but not in WAL mode, and both of
     * these are WAL, so a single transaction over the pair is not on offer.
     *
     * What the review transaction does buy is that the watermark is never left advanced for a
     * message that was not queued, whatever order the two statements are written in and whatever is
     * added between them later: a throw anywhere inside rolls the watermark back, and the next
     * sweep composes the same digest again.
     *
     * The residual failure is a process killed between the outbox commit and this one, which
     * re-sends a digest rather than dropping it. That is the direction to fail in: a duplicate is
     * a nuisance, and a silently dropped notification is the feature not working.
     */
    const commit = connection.transaction(() => {
      enqueueEmail({
        workspaceId,
        to: message.toEmail,
        subject: rendered.subject,
        bodyText: rendered.text,
        bodyHtml: rendered.html,
      });
      db.setNotificationState(message.recipientKind, message.recipientId, {
        lastNotifiedAt: through.createdAt,
        lastNotifiedCommentId: through.id,
      });
    });

    commit();
  }
}
