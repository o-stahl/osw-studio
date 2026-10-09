'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useLocalFormat } from '@/lib/i18n/use-local-format';
import {
  MessageSquare,
  MessagesSquare,
  Copy,
  Check,
  ExternalLink,
  CornerDownRight,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Section, SectionBody, SectionHeader } from '@/components/ui/section';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingRow } from '@/components/ui/setting-row';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { MIN_REVIEW_PASSWORD_LENGTH } from '@/lib/api/deployment-review-merge';
import { REVIEW_AS_TEAM_HEADER, reviewApiBase } from '@/lib/review/api-base';
import type { WireComment, WireParticipant } from '@/lib/review/comment-view';
import { cn, logger } from '@/lib/utils';

import {
  REVIEW_EXPIRY_CHOICES,
  type ReviewExpiryDuration,
  type ReviewFilter,
  buildThreads,
  countThreads,
  describeAnchor,
  expiryOptionToIso,
  filterThreads,
  isReviewExpired,
  participantColor,
  reviewPasswordState,
  passwordStateKey,
  reviewBuildState,
  reviewStatus,
  reviewExpiryKey,
  emptyThreadsKey,
} from './review-logic';
import { apiFetch, markAuthExpired } from '@/lib/api/backend-status';

/**
 * Review traffic from this panel always speaks as the team. The review routes sit outside the
 * auth-gated `/api/w/` paths, so their 401 (account session expired) raises the banner here.
 */
async function reviewFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await apiFetch(url, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init.headers as Record<string, string> | undefined), [REVIEW_AS_TEAM_HEADER]: 'team' },
  });
  if (response.status === 401) markAuthExpired();
  return response;
}

/**
 * The review block as the studio edits it.
 *
 * `passwordHash` is absent because the API never sends one (lib/api/deployment-public.ts) and never
 * accepts one either — the plaintext goes up under `password` and the server hashes it. The three
 * states of that field are the wire contract in lib/api/deployment-review-merge.ts: undefined
 * leaves the stored hash alone, null clears it, a string sets it.
 */
export interface ReviewDraft {
  enabled: boolean;
  expiresAt?: string;
  notifyByEmail?: boolean;
  /** Server-reported: whether a password is currently stored. Read-only. */
  reviewPasswordSet: boolean;
  password?: string | null;
}

interface ReviewTabProps {
  deploymentId: string;
  /** Absent in browser mode, where there is no server to send mail from. */
  workspaceId?: string;
  review: ReviewDraft;
  onChange: (review: ReviewDraft) => void;
  /**
   * Whether review mode is on in the *stored* record. The comment API answers 404 for a deployment
   * whose review is off (lib/review/access.ts), so an unsaved toggle cannot load an inbox yet.
   */
  storedEnabled: boolean;
  /** Any unsaved edit on the settings page, from the same tracking that drives the Save button. */
  isDirty: boolean;
  hasBeenPublished: boolean;
  hasPendingChanges: boolean;
  isPublishing: boolean;
  onPublish: () => void;
}

interface CommentsResponse {
  comments: WireComment[];
  participants: WireParticipant[];
  viewer: { participant_id: string; is_team: boolean };
  /** How many comments exist, which is more than `comments` holds once the server caps the list. */
  total: number;
  truncated: boolean;
}

export function ReviewTab({
  deploymentId,
  workspaceId,
  review,
  onChange,
  storedEnabled,
  isDirty,
  hasBeenPublished,
  hasPendingChanges,
  isPublishing,
  onPublish,
}: ReviewTabProps) {
  const when = useLocalFormat();
  const tc = useTranslations('common');
  const t = useTranslations('publishSettings');
  const update = (patch: Partial<ReviewDraft>) => onChange({ ...review, ...patch });

  // ── Address ──────────────────────────────────────────────────────────────
  // Unlike the public URL, which the server resolves because slugs and custom domains change where
  // a deployment is served from, the review copy has exactly one address: app/review/[deploymentId]
  // is a route on this origin and nothing reroutes it.
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const reviewUrl = `${origin}/review/${deploymentId}/`;

  const [copied, setCopied] = useState(false);
  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(reviewUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t('copyAddressFailed'));
    }
  };

  // ── Email notifications ──────────────────────────────────────────────────
  // The switch is only meaningful when a transport resolves, so the tab asks rather than assumes.
  // `null` is "not answered yet" and keeps the control disabled, so a slow answer never shows a
  // switch that appears usable and silently does nothing.
  const [mailSending, setMailSending] = useState<boolean | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setMailSending(false);
      return;
    }

    const controller = new AbortController();

    (async () => {
      try {
        const res = await apiFetch(`/api/w/${workspaceId}/mail/sending`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          setMailSending(false);
          return;
        }
        const body = (await res.json()) as { sending?: boolean };
        setMailSending(body.sending === true);
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        setMailSending(false);
      }
    })();

    return () => controller.abort();
  }, [workspaceId]);

  // ── Password ─────────────────────────────────────────────────────────────
  const [passwordEditing, setPasswordEditing] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');

  const tooShort = passwordInput.length > 0 && passwordInput.length < MIN_REVIEW_PASSWORD_LENGTH;

  /**
   * Only a password that meets the server's rule reaches the draft. Anything shorter stays in the
   * input and leaves the intent at "keep", so pressing Save while mid-typing cannot send a value
   * the route would reject.
   */
  const handlePasswordInput = (value: string) => {
    setPasswordInput(value);
    update({ password: value.length >= MIN_REVIEW_PASSWORD_LENGTH ? value : undefined });
  };

  const cancelPasswordEdit = () => {
    setPasswordEditing(false);
    setPasswordInput('');
    update({ password: undefined });
  };

  const passwordState = reviewPasswordState(review.password, review.reviewPasswordSet);

  // ── Expiry ───────────────────────────────────────────────────────────────
  const expired = isReviewExpired(review.expiresAt);
  const expiryLabel = review.expiresAt
    ? when.dateTime(review.expiresAt, { dateStyle: 'medium', timeStyle: 'short' })
    : null;

  const handleExpiryChange = (value: string) => {
    if (value === 'current') return;
    update({ expiresAt: expiryOptionToIso(value as 'never' | ReviewExpiryDuration) });
  };

  // ── Build state ──────────────────────────────────────────────────────────
  // The review copy is written by a publish, so switching the toggle on does not make the address
  // answer. `settingsVersion` bumps on that toggle (reviewChangeNeedsRepublish), which is what puts
  // the deployment into pending-changes here.
  const build = reviewBuildState({ enabled: review.enabled, isDirty, hasBeenPublished, hasPendingChanges });
  const { outOfDate } = build;
  const notBuilt = build.nothingToOpen;

  const buildNotice = build.notice ? t(build.notice) : null;

  const status = reviewStatus({ enabled: review.enabled, notBuilt, outOfDate, expired });
  const statusBadge = status === 'off' ? (
    <Badge variant="secondary">{t('off')}</Badge>
  ) : status === 'publishToApply' ? (
    <Badge variant="outline" className="border-amber-500 text-amber-500">
      {t('publishToApply')}
    </Badge>
  ) : status === 'publishToUpdate' ? (
    <Badge variant="outline" className="border-amber-500 text-amber-500">
      {t('publishToUpdate')}
    </Badge>
  ) : status === 'closed' ? (
    <Badge variant="secondary">{t('closed')}</Badge>
  ) : (
    <Badge variant="outline" className="border-green-500 text-green-500">
      {t('live')}
    </Badge>
  );

  return (
    <div className="flex flex-col gap-4">
      <Section>
        <SectionHeader icon={MessagesSquare} title={t('reviewMode')}>
          {statusBadge}
        </SectionHeader>
        <SectionBody className="px-4 py-1">
          <SettingRow
            title={t('buildReviewCopy')}
            description={t('reviewModeNote')}
          >
            <Switch
              id="review-enabled"
              checked={review.enabled}
              onCheckedChange={(checked) => update({ enabled: checked })}
            />
          </SettingRow>

          {review.enabled && (
            <>
              <SettingRow
                className="flex-wrap"
                title={t('address')}
                description={
                  <>
                    {t('reviewLinkHelp')}
                    <span className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-2.5 py-1.5">
                      <code className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-foreground">
                        {reviewUrl}
                      </code>
                    </span>
                  </>
                }
              >
                <div className="flex items-center gap-1.5">
                  <Button variant="outline" size="sm" onClick={copyAddress} className="gap-1.5">
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? tc('labels.copied') : t('copy')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => window.open(reviewUrl, '_blank')}
                    className="gap-1.5"
                    disabled={notBuilt}
                    title={notBuilt ? t('publishFirst') : undefined}
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('open')}
                  </Button>
                </div>
              </SettingRow>

              <SettingRow
                className="flex-wrap"
                title={
                  <>
                    {tc('labels.password')} <span className="font-normal text-muted-foreground">{tc('labels.optionalParen')}</span>
                  </>
                }
                description={
                  passwordEditing ? (
                    <>
                      {t('reviewPasswordHelp')}
                      <span className="mt-2 flex flex-wrap items-center gap-2">
                        <Input
                          autoFocus
                          type="password"
                          value={passwordInput}
                          onChange={(e) => handlePasswordInput(e.target.value)}
                          placeholder={t('newPassword')}
                          className="h-8 w-full max-w-[220px] text-[13px]"
                        />
                        <span
                          className={cn(
                            'text-xs',
                            tooShort ? 'text-destructive' : 'text-muted-foreground'
                          )}
                        >
                          {t('atLeastChars', { count: MIN_REVIEW_PASSWORD_LENGTH })}
                        </span>
                      </span>
                    </>
                  ) : (
                    <>{t('reviewPasswordHelp')}</>
                  )
                }
              >
                <div className="flex items-center gap-1.5">
                  {passwordEditing ? (
                    <>
                      <Button
                        variant="accent"
                        size="sm"
                        disabled={typeof review.password !== 'string'}
                        onClick={() => setPasswordEditing(false)}
                      >
                        {tc('actions.done')}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={cancelPasswordEdit}>
                        {tc('actions.cancel')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-muted-foreground whitespace-nowrap">
                        {t(passwordStateKey(passwordState))}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setPasswordInput('');
                          setPasswordEditing(true);
                        }}
                      >
                        {review.reviewPasswordSet ? tc('actions.change') : t('set')}
                      </Button>
                      {passwordState === 'set' && (
                        <Button variant="ghost" size="sm" onClick={() => update({ password: null })}>
                          {tc('actions.clear')}
                        </Button>
                      )}
                      {(passwordState === 'pending-set' || passwordState === 'pending-clear') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => update({ password: undefined })}
                        >
                          {tc('actions.undo')}
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </SettingRow>

              <SettingRow
                className="flex-wrap"
                title={t('emailNotifications')}
                description={
                  mailSending
                    ? t('digestOn')
                    : t('digestNoMail')
                }
              >
                <div className="flex items-center gap-2">
                  {!mailSending && <Badge variant="secondary">{tc('labels.notAvailable')}</Badge>}
                  <Switch
                    id="review-notify"
                    checked={review.notifyByEmail === true && mailSending === true}
                    disabled={!mailSending}
                    onCheckedChange={(checked) => update({ notifyByEmail: checked })}
                  />
                </div>
              </SettingRow>

              <SettingRow
                className="flex-wrap"
                title={
                  <>
                    {t('stopServing')}{' '}
                    <span className="font-normal text-muted-foreground">{tc('labels.optionalParen')}</span>
                  </>
                }
                description={t(reviewExpiryKey(!!expiryLabel, expired), { date: expiryLabel ?? '' })}
              >
                <Select value={review.expiresAt ? 'current' : 'never'} onValueChange={handleExpiryChange}>
                  <SelectTrigger id="review-expiry" className="w-[190px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {review.expiresAt && (
                      <SelectItem value="current">{expired ? t('closed') : t('keepCurrentDate')}</SelectItem>
                    )}
                    {REVIEW_EXPIRY_CHOICES.map((choice) => (
                      <SelectItem key={choice} value={choice}>
                        {t(`expiry.${choice}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            </>
          )}
        </SectionBody>
      </Section>

      {buildNotice && (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-3 sm:flex-row sm:items-center dark:border-yellow-800 dark:bg-yellow-950">
          <p className="min-w-0 flex-1 text-sm text-yellow-800 dark:text-yellow-200">{buildNotice}</p>
          {!isDirty && (
            <Button variant="outline" size="sm" onClick={onPublish} disabled={isPublishing}>
              {isPublishing ? t('publishing') : t('publishNow')}
            </Button>
          )}
        </div>
      )}

      <ReviewComments deploymentId={deploymentId} storedEnabled={storedEnabled} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the review copy at the page a comment was left on.
 *
 * The comment's anchor — a CSS selector plus the text it matched — was computed by the widget
 * against the published DOM, so the review copy is the one place it resolves by construction. The
 * workspace preview renders current source instead, which is why sending someone there dropped the
 * anchor and left them on a page with no indication of which element was meant.
 *
 * A workspace member is admitted as `team` without the password gate (lib/review/access.ts), so
 * this lands them on the page with the pins, the replies and the resolve control already there.
 */
function openReviewPage(deploymentId: string, pagePath: string, commentId: string): void {
  // A bare '/' is dropped rather than appended: `/review/{id}/` is answered with a 308 to the
  // unslashed form, and while that redirect does carry the query through, the link should not
  // depend on it.
  // Defensive: validation refuses a stored path carrying a query or fragment, but rows written
  // before that rule exist, and either would swallow the `osw-comment` parameter appended below.
  const bare = pagePath.split('?')[0].split('#')[0];
  const normalized = bare.startsWith('/') ? bare : `/${bare}`;
  const path = normalized === '/' ? '' : normalized;
  // `osw-comment` is read by the widget on boot: it opens that thread in the drawer and scrolls the
  // page to the element it was left against. Without it a page carrying several comments lands the
  // reader at the top with no indication of which pin was meant.
  const url = `/review/${encodeURIComponent(deploymentId)}${path}?osw-comment=${encodeURIComponent(commentId)}`;
  window.open(url, '_blank', 'noopener');
}

function ReviewComments({
  deploymentId,
  storedEnabled,
}: {
  deploymentId: string;
  storedEnabled: boolean;
}) {
  const tc = useTranslations('common');
  const t = useTranslations('publishSettings');
  const [data, setData] = useState<CommentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewFilter>('open');
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await reviewFetch(`${reviewApiBase(deploymentId)}/comments`);
      // 404 is the review layer's answer for "this deployment has no review copy open right now" —
      // review switched off in the stored record, or the round expired. It is a state, not a
      // failure, and reporting it as one sent people looking for a broken server.
      if (response.status === 404) {
        setData(null);
        setError(t('reviewCopyNotOpen'));
        return;
      }
      if (!response.ok) throw new Error(`Could not load comments (${response.status})`); // i18n-ignore: only logged
      setData((await response.json()) as CommentsResponse);
    } catch (err) {
      logger.error('[ReviewTab] Failed to load comments:', err);
      setError(t('loadCommentsError'));
    } finally {
      setLoading(false);
    }
  }, [t, deploymentId]);

  useEffect(() => {
    if (!storedEnabled) {
      setData(null);
      return;
    }
    void load();
  }, [storedEnabled, load]);

  const threads = useMemo(() => buildThreads(data?.comments ?? []), [data]);
  const counts = useMemo(() => countThreads(threads), [threads]);
  const visible = useMemo(() => filterThreads(threads, filter), [threads, filter]);

  const setStatus = async (commentId: string, status: 'open' | 'resolved') => {
    setBusyId(commentId);
    try {
      const response = await reviewFetch(`${reviewApiBase(deploymentId)}/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (!response.ok) throw new Error('Could not update the comment');
      await load();
    } catch (err) {
      logger.error('[ReviewTab] Failed to change comment status:', err);
      toast.error(t('updateCommentFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const postReply = async (root: WireComment) => {
    const body = replyBody.trim();
    if (!body) return;

    setBusyId(root.id);
    try {
      // Only content travels: authorship is derived server-side from the account session, so a
      // reply from here carries the team badge without this asking for it.
      const response = await reviewFetch(`${reviewApiBase(deploymentId)}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body,
          parent_id: root.id,
          page_path: root.page_path,
          selector: root.selector ?? undefined,
          anchor_text: root.anchor_text ?? undefined,
        }),
      });
      if (!response.ok) throw new Error('Could not post the reply');
      setReplyingTo(null);
      setReplyBody('');
      await load();
    } catch (err) {
      logger.error('[ReviewTab] Failed to post reply:', err);
      toast.error(t('postReplyFailed'));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Section>
      <SectionHeader icon={MessageSquare} title={t('comments')} className="flex-wrap gap-y-2">
        {storedEnabled && (
          <>
            <ToggleGroup
              type="single"
              value={filter}
              onValueChange={(value) => value && setFilter(value as ReviewFilter)}
            >
              <ToggleGroupItem value="open" size="sm" className="text-xs">
                {t('filterOpen', { count: counts.open })}
              </ToggleGroupItem>
              <ToggleGroupItem value="resolved" size="sm" className="text-xs">
                {t('filterResolved', { count: counts.resolved })}
              </ToggleGroupItem>
              <ToggleGroupItem value="all" size="sm" className="text-xs">
                {t('all')}
              </ToggleGroupItem>
            </ToggleGroup>
            <Button variant="ghost" size="sm" onClick={load} title={t('reloadComments')}>
              <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            </Button>
          </>
        )}
      </SectionHeader>

      <SectionBody className="px-4 py-1">
        {!storedEnabled ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {t('commentsReadOnlyNote')}
          </p>
        ) : loading && !data ? (
          <div className="flex justify-center py-8">
            <Spinner size={24} />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <p className="text-sm text-muted-foreground">{error}</p>
            <Button variant="outline" size="sm" onClick={load}>
              {t('tryAgain')}
            </Button>
          </div>
        ) : (
          <>
            {data?.truncated && (
              // Said outright rather than left to the counts: the filter chips above read as the
              // whole round, and acting on a partial one is the failure a silent cap produces.
              <p className="border-b border-border py-2 text-xs text-muted-foreground">
                {t('showingRecent', { shown: data.comments.length, total: data.total })}
              </p>
            )}
            {visible.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t(emptyThreadsKey(counts.all, filter))}
              </p>
            ) : (
              visible.map((thread, index) => (
                // Wraps rather than squeezing: the actions are a fixed width, so on a narrow column an
                // unwrapped row would shrink the comment body to one word per line.
                <div
                  key={thread.root.id}
                  className="flex flex-wrap items-start gap-x-3 gap-y-2 border-t border-border py-3 first:border-t-0"
                >
                  <span
                    className={cn(
                      'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-bold tabular-nums',
                      thread.root.status === 'resolved'
                        ? 'bg-green-500/15 text-green-600 dark:text-green-500'
                        : 'bg-primary/15 text-primary'
                    )}
                  >
                    {index + 1}
                  </span>

                  <div className="min-w-[10rem] flex-1">
                    <div className="text-[13px]">{thread.root.body}</div>
                    <CommentMeta comment={thread.root} />

                    {thread.replies.map((reply) => (
                      <div key={reply.id} className="mt-2 border-l-2 border-border pl-3">
                        <div className="flex items-start gap-1.5 text-xs">
                          <CornerDownRight className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                          <span>{reply.body}</span>
                        </div>
                        <CommentMeta comment={reply} anchored={false} />
                      </div>
                    ))}

                    {replyingTo === thread.root.id && (
                      <div className="mt-2 flex flex-col gap-2">
                        <Textarea
                          autoFocus
                          rows={2}
                          value={replyBody}
                          onChange={(e) => setReplyBody(e.target.value)}
                          placeholder={t('replyPlaceholder')}
                          className="text-[13px]"
                        />
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="accent"
                            size="sm"
                            disabled={!replyBody.trim() || busyId === thread.root.id}
                            onClick={() => postReply(thread.root)}
                          >
                            {busyId === thread.root.id ? t('posting') : t('postReply')}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setReplyingTo(null);
                              setReplyBody('');
                            }}
                          >
                            {tc('actions.cancel')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="ml-auto flex shrink-0 flex-wrap items-start justify-end gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setReplyingTo(thread.root.id);
                        setReplyBody('');
                      }}
                    >
                      {t('reply')}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        openReviewPage(deploymentId, thread.root.page_path, thread.root.id)
                      }
                    >
                      {t('show')}
                    </Button>
                    <Button
                      variant={thread.root.status === 'resolved' ? 'ghost' : 'accent'}
                      size="sm"
                      disabled={busyId === thread.root.id}
                      onClick={() =>
                        setStatus(thread.root.id, thread.root.status === 'resolved' ? 'open' : 'resolved')
                      }
                    >
                      {thread.root.status === 'resolved' ? t('reopen') : t('resolve')}
                    </Button>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </SectionBody>
    </Section>
  );
}

function CommentMeta({ comment, anchored = true }: { comment: WireComment; anchored?: boolean }) {
  const t = useTranslations('publishSettings');
  const when = useLocalFormat();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {anchored && <span className="font-mono">{describeAnchor(comment)}</span>}
      <span className="inline-flex items-center gap-1.5">
        <i
          className="inline-block size-2 shrink-0 rounded-full"
          style={{ background: participantColor(comment.participant_id, comment.is_team) }}
        />
        <b className="font-semibold text-foreground">{comment.author_name}</b>
        {comment.is_team && (
          <span className="rounded-full border border-border px-1.5 py-px text-[10px]">{t('teamBadge')}</span>
        )}
      </span>
      <span>{when.recent(comment.created_at)}</span>
    </div>
  );
}
