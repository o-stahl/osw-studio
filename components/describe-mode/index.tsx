'use client';

import { useState, useCallback, useRef, useMemo } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ChatPanel } from '@/components/chat-panel';
import { MultiAgentOrchestrator } from '@/lib/llm/multi-agent-orchestrator';
import { continueAfterStop } from '@/lib/llm/continue-prompt';
import type { BriefState, ProjectBrief } from '@/lib/describe/types';
import { createEmptyBriefState, isBriefReady } from '@/lib/describe/types';
import { createProjectFromBrief } from '@/lib/describe/create-from-brief';
import { getProvider } from '@/lib/llm/providers/registry';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { isProjectProviderReady } from '@/lib/llm/models/project-assignment';
import { resolveActiveAssignment } from '@/lib/llm/models/template-store';
import type { DebugEvent } from '@/lib/stores/types';
import type { Project } from '@/lib/vfs/types';
import { toast } from 'sonner';
import { BriefSidebar } from './brief-sidebar';
import { CreateConfirmation } from './create-confirmation';
import { WELCOME_TEXT } from './welcome';
import { track } from '@/lib/telemetry';

const WELCOME_ID = 'describe-welcome';

/**
 * The events with the welcome's text swapped for `welcome`. Later deltas can coalesce into its
 * event, so only its first chunk is swapped.
 */
export function withLocalWelcome(events: DebugEvent[], welcome: string): DebugEvent[] {
  return events.map((evt) => {
    if (evt.id !== WELCOME_ID) return evt;
    const text = { text: welcome };
    return { ...evt, data: evt.data?.all ? { all: [text, ...evt.data.all.slice(1)] } : text };
  });
}

interface DescribeModeProps {
  onProjectCreated: (project: Project) => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function DescribeMode({ onProjectCreated, onDirtyChange }: DescribeModeProps) {
  const t = useTranslations('describe');
  const locale = useLocale();
  const [events, setEvents] = useState<DebugEvent[]>([
    {
      id: WELCOME_ID,
      timestamp: Date.now(),
      event: 'assistant_delta',
      data: { text: WELCOME_TEXT },
      count: 1,
      version: 1,
    },
  ]);
  const [generating, setGenerating] = useState(false);
  const [briefState, setBriefState] = useState<BriefState>(createEmptyBriefState);
  const [creating, setCreating] = useState(false);

  // Subscribe to the reactive model-config signal so readiness + the footer label recompute
  // when the global working selection changes (bumped by the root-mounted useModelConfigSignal).
  const modelConfigVersion = useWorkspaceStore(s => s.modelConfigVersion);
  // Effective model of the global working selection (drives the footer picker label). Resolved
  // once per render; modelConfigVersion forces a re-render on model picks / provider connects.
  void modelConfigVersion;
  const activeAgent = resolveActiveAssignment().agent;
  const currentModel = activeAgent.model;

  // Pending creation confirmation — shown as composerOverlay
  const [pendingCreateBrief, setPendingCreateBrief] = useState<ProjectBrief | null>(null);

  // System note — shown in MessageContext, prepended to next message, non-dismissable
  const [systemNote, setSystemNote] = useState<string | null>(null);

  const orchestratorRef = useRef<MultiAgentOrchestrator | null>(null);
  const idCounter = useRef(0);

  // ---- Provider readiness ----
  // Global resolved-provider readiness; recomputed each render (re-runs on the modelConfigVersion
  // re-render above, so it refreshes when a provider connects or the working selection changes).
  const providerReady = isProjectProviderReady();

  // ---- Model display name ----
  const getModelDisplayName = useCallback((modelId: string): string => {
    if (!modelId) return t('selectModel');
    const provConfig = getProvider(activeAgent.provider);
    const found = provConfig?.models?.find(m => m.id === modelId);
    if (found) return found.name;
    const parts = modelId.split('/');
    const name = parts[parts.length - 1];
    return name.split('-').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }, [activeAgent.provider, t]);

  // ---- Event coalescing (matches workspace pattern) ----
  const addEvent = useCallback((event: string, data: any) => {
    setEvents(prev => {
      const shouldCoalesce = event === 'assistant_delta' || event === 'tool_param_delta' || event === 'reasoning_delta';

      if (shouldCoalesce && prev.length > 0) {
        const searchLimit = Math.max(0, prev.length - 4);
        for (let i = prev.length - 1; i >= searchLimit; i--) {
          if (prev[i].event === event) {
            const target = prev[i];
            const updatedEvent: DebugEvent = {
              ...target,
              timestamp: Date.now(),
              version: (target.version || 1) + 1,
              count: (target.count || 1) + 1,
              data: {
                all: target.data.all
                  ? [...target.data.all, data]
                  : [target.data, data]
              }
            };
            return [...prev.slice(0, i), updatedEvent, ...prev.slice(i + 1)];
          }
        }
      }

      return [...prev, {
        id: `describe-${Date.now()}-${idCounter.current++}`,
        timestamp: Date.now(),
        event,
        data,
        count: 1,
        version: 1
      }];
    });
  }, []);

  // ---- Brief state updates ----
  const applyBriefUpdate = useCallback((data: any) => {
    const incoming = { ...(data.brief || {}) };
    // The LLM sometimes emits `pages` as objects like {name, title} instead of
    // the documented string[]. Normalize here so the sidebar and downstream
    // serializers (which both use pages.join(', ')) never see [object Object].
    if (Array.isArray(incoming.pages)) {
      incoming.pages = incoming.pages
        .map((p: any) => {
          if (typeof p === 'string') return p;
          if (p && typeof p === 'object') return p.name || p.title || p.slug || '';
          return '';
        })
        .filter((s: string) => s.length > 0);
    }
    setBriefState(prev => ({
      ...prev,
      brief: { ...prev.brief, ...incoming },
      pending: data.pending ?? prev.pending,
      totalDecisions: data.totalDecisions ?? prev.totalDecisions,
      resolvedCount: data.resolvedCount ?? prev.resolvedCount,
    }));
  }, []);

  // ---- Spec updates ----
  const applySpecUpdate = useCallback((data: any) => {
    setBriefState(prev => ({
      ...prev,
      spec: [...prev.spec, { heading: data.section, content: data.content }],
    }));
  }, []);

  // ---- Extract conversation transcript from events ----
  // Includes user replies, agent prose, and a summary of each setup-mode
  // bash call (ask prompts, spec sections, propose-create) so the saved
  // .DESIGN-CONVERSATION.md captures the actual back-and-forth — without
  // tool-call summaries the file is just user fragments without context.
  const getConversation = useCallback((): Array<{ role: string; content: string }> => {
    const messages: Array<{ role: string; content: string }> = [];

    const summarizeShellCmd = (cmd: string): string | null => {
      const trimmed = cmd.trim();

      // ask [--prompt "Q"] "Option" "Option"...
      if (/^ask\b/.test(trimmed)) {
        const promptMatch = trimmed.match(/--prompt\s+(?:"([^"]*)"|'([^']*)')/);
        const prompt = promptMatch ? (promptMatch[1] ?? promptMatch[2] ?? '') : '';
        const optMatches = [...trimmed.matchAll(/"([^"]+)"|'([^']+)'/g)]
          .map(m => m[1] ?? m[2] ?? '')
          .filter(Boolean)
          .filter(s => s !== prompt);
        const head = prompt ? prompt : 'Asked the user';
        const opts = optMatches.length > 0 ? `\n\nOptions: ${optMatches.join(' · ')}` : '';
        return `${head}${opts}`;
      }

      // spec --append "Section" << 'EOF' content EOF
      const specMatch = trimmed.match(/^spec\s+--append\s+(?:"([^"]+)"|'([^']+)')\s*<<-?\s*['"]?\w+['"]?\n([\s\S]*?)\n\w+\s*$/);
      if (specMatch) {
        const section = specMatch[1] ?? specMatch[2] ?? 'Spec'; // i18n-ignore: written into .DESIGN-CONVERSATION.md, which the agent reads
        const body = (specMatch[3] || '').trim();
        return `(spec: ${section})\n\n${body}`;
      }

      // propose-create — short marker
      if (/^propose-create\b/.test(trimmed)) {
        return '(proposed project creation)';
      }

      // brief --merge — skip; the brief itself becomes part of .PROMPT.md/.DESIGN.md
      if (/^brief\s+--merge\b/.test(trimmed)) {
        return null;
      }

      return null;
    };

    for (const evt of events) {
      if (evt.event === 'conversation_message') {
        const msg = evt.data?.message;
        if (msg?.role === 'user') {
          // Use displayContent (clean prompt without prepended context/skills)
          const display = msg.ui_metadata?.displayContent;
          const content = typeof display === 'string' ? display
            : typeof msg.content === 'string' ? msg.content : '';
          if (content) messages.push({ role: 'user', content });
        } else if (msg?.role === 'assistant') {
          const content = typeof msg.content === 'string' ? msg.content : '';
          const cleaned = content.trim();
          if (cleaned) messages.push({ role: 'assistant', content: cleaned });

          // Pull setup tool calls into the transcript so ask prompts and
          // spec entries aren't lost.
          if (Array.isArray(msg.tool_calls)) {
            for (const call of msg.tool_calls) {
              if (call?.function?.name !== 'bash' && call?.function?.name !== 'shell') continue;
              try {
                const parsedArgs = JSON.parse(call.function.arguments || '{}');
                const cmd = typeof (parsedArgs?.command ?? parsedArgs?.cmd) === 'string' ? (parsedArgs.command ?? parsedArgs.cmd) : '';
                const summary = summarizeShellCmd(cmd);
                if (summary) messages.push({ role: 'assistant', content: summary });
              } catch {
                // ignore unparseable tool call args
              }
            }
          }
        }
      } else if (evt.event === 'assistant_delta' && messages.length === 0) {
        // Catch the synthetic welcome message
        const items = evt.data?.all || [evt.data];
        const text = items.map((d: any) => d?.text || '').join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    }
    return messages;
  }, [events]);

  // The welcome is kept in English for the transcript above and worded in the app's language here.
  const displayEvents = useMemo(() => withLocalWelcome(events, t('welcome')), [events, t]);

  // ---- Project ready (agent ran propose-create — show confirmation) ----
  // The bash-based propose-create command emits an empty payload; the brief
  // is already accumulated client-side from prior brief_update events.
  const applyProjectReady = useCallback(() => {
    setBriefState(prev => {
      // Mark the latest brief as the pending-create candidate.
      setPendingCreateBrief(prev.brief);
      return prev;
    });
  }, []);

  // ---- Actual project creation ----
  const doCreateProject = useCallback(async (brief: ProjectBrief) => {
    setCreating(true);
    try {
      const project = await createProjectFromBrief({
        brief,
        spec: briefState.spec,
        conversation: getConversation(),
      });
      track('project_create', {
        method: 'describe',
        runtime: brief.runtime ?? 'static',
        template: brief.template ?? 'blank',
      });
      toast.success(t('projectCreated', { name: project.name }));
      onProjectCreated(project);
    } catch (err: any) {
      toast.error(t('createFailed', { error: String(err.message ?? err) }));
    } finally {
      setCreating(false);
    }
  }, [briefState.spec, getConversation, onProjectCreated, t]);

  // ---- Confirmation handlers ----
  const handleConfirmCreate = useCallback(() => {
    if (!pendingCreateBrief) return;
    const brief = { ...briefState.brief, ...pendingCreateBrief };
    setPendingCreateBrief(null);
    doCreateProject(brief);
  }, [pendingCreateBrief, briefState.brief, doCreateProject]);

  const handleDeclineCreate = useCallback(() => {
    setPendingCreateBrief(null);
    setSystemNote('The user declined project creation — they want to adjust something before creating.');
  }, []);

  // ---- Generate handler ----
  const describeDirtyRef = useRef(false);
  const handleGenerate = useCallback(async (prompt: string) => {
    if (!describeDirtyRef.current) {
      describeDirtyRef.current = true;
      onDirtyChange?.(true);
    }
    // Resolve the assignment FRESH here (at click time) so generation always uses the current
    // global working selection. On the first generate we build the orchestrator with it; on
    // later generates we update the cached instance's assignment (preserving the in-flight
    // describe conversation) so the picked model tracks the working selection on every generate.
    const assignment = resolveActiveAssignment();
    if (!orchestratorRef.current) {
      orchestratorRef.current = new MultiAgentOrchestrator(
        'describe-setup',
        'setup',
        (message: string, step?: unknown) => {
          addEvent(message, step);

          if (message === 'brief_update') applyBriefUpdate(step);
          if (message === 'spec_update') applySpecUpdate(step);
          if (message === 'project_ready') applyProjectReady();
        },
        { model: assignment.agent.model, assignment }
      );
    } else {
      orchestratorRef.current.setAssignment(assignment);
    }

    // Prepend system note (e.g. "user declined creation") to the message
    let messageContent = prompt;
    if (systemNote) {
      messageContent = `[Context: ${systemNote}]\n\n${prompt}`;
      setSystemNote(null);
    }

    // Clear any pending confirmation when user sends a new message
    setPendingCreateBrief(null);

    setGenerating(true);
    try {
      await orchestratorRef.current.execute(messageContent, {
        displayPrompt: prompt, // UI shows clean prompt, LLM sees context-prepended version
      });
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        toast.error(t('generationFailed', { error: String(err.message ?? err) }));
      }
    } finally {
      setGenerating(false);
    }
  }, [addEvent, applyBriefUpdate, applySpecUpdate, applyProjectReady, systemNote, onDirtyChange, t]);

  // ---- Stop handler ----
  const handleStop = useCallback(() => {
    orchestratorRef.current?.stop();
    setGenerating(false);
  }, []);

  // ---- Sidebar "Create now" button ----
  const briefReady = isBriefReady(briefState.brief);
  const handleCreateNow = useCallback(async () => {
    if (!briefReady || creating) return;
    await doCreateProject(briefState.brief);
  }, [briefReady, creating, briefState.brief, doCreateProject]);

  // Composer overlay — replaces the input area when creation is pending
  const composerOverlay = pendingCreateBrief ? (
    <CreateConfirmation
      name={pendingCreateBrief.name || briefState.brief.name || t('untitledProject')}
      onConfirm={handleConfirmCreate}
      onDecline={handleDeclineCreate}
      creating={creating}
    />
  ) : undefined;

  return (
    <div className="flex h-full w-full">
      {/* Chat panel — no header, no border radius on the right side (sidebar is adjacent) */}
      <div className="flex-1 min-w-0">
        {/* Keyed by language: the panel keeps text it has already processed, so the welcome's new
            wording would not show until a remount. */}
        <ChatPanel
          key={locale}
          events={displayEvents}
          generating={generating}
          onGenerate={handleGenerate}
          onStop={handleStop}
          onContinue={(withModel) => continueAfterStop(withModel, handleGenerate)}
          focusContext={null}
          onClearFocus={() => {}}
          mode="code"
          setMode={() => {}}
          activeInterview={null}
          onStartInterview={() => {}}
          onHandoff={() => {}}
          currentModel={currentModel}
          getModelDisplayName={getModelDisplayName}
          providerReady={providerReady}
          supportsVision={false}
          hideHeader
          className="rounded-none border-0"
          composerOverlay={composerOverlay}
          systemNote={systemNote}
        />
      </div>

      {/* Brief sidebar */}
      <div className="hidden md:block w-80 shrink-0">
        <BriefSidebar
          state={briefState}
          ready={briefReady}
          creating={creating}
          onCreateNow={handleCreateNow}
        />
      </div>
    </div>
  );
}
