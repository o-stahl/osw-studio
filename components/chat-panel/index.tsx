'use client';

import { useState, useEffect, useRef, useMemo, useCallback, DragEvent, ClipboardEvent } from 'react';
import { useTranslations } from 'next-intl';
import { MessageSquare, Loader2, ClipboardList, Send, ChevronUp, ChevronDown, Code, Trash2, Image as ImageIcon, Type, Mic, Square, Plus, FileText, LogIn, Settings2, Camera } from 'lucide-react';
import type { WorkspaceMode, ActiveInterview } from '@/lib/stores/slices/project';
import { InterviewPicker } from './interview-picker';
import { InterviewTemplatesManager } from '@/components/interview/InterviewTemplatesManager';
import { interviewTemplatesService } from '@/lib/interview/templates-service';
import type { InterviewTemplate } from '@/lib/interview/types';
import { Tip } from '@/components/ui/tooltip';
import { modShortcut } from '@/lib/platform';
import type { DebugEvent } from '@/lib/stores/types';
import { EventProcessor, type ToolCall } from './event-processor';
import { useFollowNewest } from './use-follow-newest';
import { classifyCommand } from '@/lib/agent-activity/classify-command';
import { shouldShowPacingNotice, type PacingToolItem } from '@/lib/pacing-notice';
import { STOP_REASONS, shouldShowStopReason, type StopReasonId } from '@/lib/telemetry/stop-reason';
import { configManager } from '@/lib/config/storage';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pendingImageFromDataUrl } from '@/lib/llm/pending-image';
import { PanelContainer, PanelHeader } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { UnifiedSettingsModal, type SettingsPane } from '@/components/unified-settings';
import { createPortal } from 'react-dom';
import { ProjectModelsPanel } from '@/components/providers-models/project-models-panel';
import { hasAnyConnectedProvider } from '@/lib/llm/providers/connection-status';
import { SUGGESTION_PILLS, QUICK_EDIT_PILLS, INLINE_SUGGESTION_COUNT, type BuiltInPillId } from '@/lib/constants/suggestion-pills';
import { checkHFCapabilities, loginHF } from '@/lib/auth/hf-auth';
import { OPEN_MODEL_PICKER_EVENT } from './limit-cards';
import { ConnectChooser } from './connect-options';
import { connectSettled } from '@/lib/llm/models/global-auto-assign';
import { isFreeModels } from '@/lib/llm/suggestions/free-models';
import { detectDeploymentType } from '@/lib/telemetry/config';
import { FocusContextPayload } from '@/lib/preview/types';
import { PendingImage, PendingAudio, PendingFile } from '@/lib/llm/multi-agent-orchestrator';
import { useAudioRecorder } from '@/lib/audio/use-audio-recorder';
import { useSpeechRecognition } from '@/lib/audio/use-speech-recognition';
import { AudioSpectrogram } from './audio-spectrogram';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import type { PlacedBlock } from '@/lib/semantic-blocks/types';
import { MessageContext } from '@/components/message-context';
import { PermissionModeSelector } from '@/components/permissions/PermissionModeSelector';
import { ApprovalCard } from '@/components/permissions/ApprovalCard';
import { track } from '@/lib/telemetry';
import { toast } from 'sonner';
import { useWorkspaceStore } from '@/lib/stores/workspace';
import { resolveActiveAssignment } from '@/lib/llm/models/template-store';
import { selectPromptSuggestions } from '@/lib/vfs/suggestion-paths';

type FocusTarget = FocusContextPayload & { timestamp: number };

interface ChatPanelProps {
  events: DebugEvent[];
  /**
   * The page the preview is on, so suggestions scoped to particular pages can be offered first.
   * Null before the preview reports one, which selectPromptSuggestions reads as "offer everything".
   */
  previewPath?: string | null;
  // Input functionality
  generating: boolean;
  onGenerate: (prompt: string, images?: PendingImage[], audio?: PendingAudio[], files?: PendingFile[]) => void;
  onStop: () => void;
  /**
   * The selected element **as included in the next message**, not merely as selected.
   *
   * Selecting an element in the preview shows its toolbar and feeds the Inspector; only the
   * toolbar's include button puts it here. The owner gates this prop — the chat panel has no view
   * of the distinction and must not try to reconstruct one.
   */
  focusContext: FocusTarget | null;
  /**
   * The chip's ✕. Takes the element out of the *message*, and deliberately cannot take it out of
   * the selection: this is not a setter, because clearing `focusContext` from here would tear down
   * the preview toolbar and empty the Inspector's Styles tab.
   */
  onClearFocus: () => void;
  focusPreviewSnippet?: string;
  // Settings
  mode: WorkspaceMode;
  setMode: (mode: WorkspaceMode) => void;
  activeInterview: ActiveInterview | null;
  onStartInterview: (template: InterviewTemplate) => void;
  currentModel: string;
  getModelDisplayName: (modelId: string) => string;
  // Tour/lock state
  isTourLockingInput?: boolean;
  // Clear chat
  onClearChat?: () => void;
  // Close panel
  onClose?: () => void;
  // Model capabilities
  supportsVision?: boolean;
  inputModalities?: string[];
  // Provider has credentials configured
  providerReady?: boolean;
  // Runtime errors
  runtimeErrors?: string[];
  onSendRuntimeErrors?: () => void;
  onClearRuntimeErrors?: () => void;
  // Semantic blocks
  placedBlocks?: PlacedBlock[];
  onRemovePlacedBlock?: (placementId: string) => void;
  onClearPlacedBlocks?: () => void;
  // Layout overrides
  hideHeader?: boolean;
  /**
   * The conversation, as the owner draws it: the workspace and describe mode both pass a thread,
   * built where the save, restore, undo and answers it offers already live.
   */
  thread: React.ReactNode;
  /**
   * The simple view, in quick edit, which hides the panel's more involved controls: no
   * `PermissionModeSelector` and no interview template management, the quick-edit starters instead
   * of the build ones and offered after the first message too, and a placeholder that asks for a
   * change rather than a site. The model picker and the mode menu stay: both are ordinary choices,
   * and the mode is the agent's, not the surface.
   */
  simple?: boolean;
  /**
   * The panel is the only one open, so it has the whole window: the messages and the composer are
   * held to a reading column in the middle rather than stretched across it.
   */
  solo?: boolean;
  /**
   * Capture the preview as it is, as a data URL, for the attach menu's Screenshot item. Absent when
   * there is no preview to capture, which hides the item.
   */
  onCaptureContextScreenshot?: () => Promise<string | null>;
  className?: string;
  /** Content rendered in place of the composer (e.g. creation confirmation) */
  composerOverlay?: React.ReactNode;
  /** Non-dismissable system note shown in context area (consumed on next send) */
  systemNote?: string | null;
}

export function ChatPanel({
  events,
  previewPath,
  generating,
  onGenerate,
  onStop,
  focusContext,
  onClearFocus,
  focusPreviewSnippet,
  mode,
  setMode,
  activeInterview,
  onStartInterview,
  currentModel,
  getModelDisplayName,
  isTourLockingInput = false,
  onClearChat,
  onClose,
  supportsVision = false,
  inputModalities = ['text'],
  providerReady = true,
  runtimeErrors = [],
  onSendRuntimeErrors,
  onClearRuntimeErrors,
  placedBlocks,
  onRemovePlacedBlock,
  onClearPlacedBlocks,
  hideHeader,
  thread,
  simple = false,
  solo = false,
  onCaptureContextScreenshot,
  className,
  composerOverlay,
  systemNote,
}: ChatPanelProps) {
  const t = useTranslations('chat');
  const tc = useTranslations('common');
  const tModels = useTranslations('models');
  const tConnect = useTranslations('connect');
  const workspaceReady = useWorkspaceStore(s => s.workspaceReady);
  const modelConfigVersion = useWorkspaceStore(s => s.modelConfigVersion);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showMobileSettings, setShowMobileSettings] = useState(false);
  const [showSettingsManage, setShowSettingsManage] = useState(false);
  const [settingsManagePane, setSettingsManagePane] = useState<SettingsPane>('models');
  const openProvidersManage = useCallback((tab: 'models' | 'connections' | 'templates') => {
    setSettingsManagePane(tab as SettingsPane);
    setShowSettingsManage(true);
  }, []);
  // Nothing at all is connected: the empty chat offers ways to connect instead of a blank thread.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- re-read when the model config changes
  const needsConnection = useMemo(() => !providerReady && !hasAnyConnectedProvider(), [providerReady, modelConfigVersion]);
  // HF Space one-click sign-in: when no provider is connected and we're on an HF
  // Space, offer "Sign in with HuggingFace" OAuth in place of the "Select provider"
  // button. Probed once on mount, only on HF Spaces.
  const [hfOAuth, setHfOAuth] = useState<{ oauthAvailable: boolean; clientId: string | null; scopes: string } | null>(null);
  useEffect(() => {
    if (providerReady) return;
    if (detectDeploymentType() !== 'hf_space') return;
    let cancelled = false;
    checkHFCapabilities()
      .then((caps) => {
        if (!cancelled) setHfOAuth({ oauthAvailable: caps.oauthAvailable, clientId: caps.clientId, scopes: caps.scopes });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [providerReady]);
  const handleHFSignIn = useCallback(async () => {
    if (!hfOAuth?.clientId) return;
    // Stash the current project id so we can restore it after the OAuth round-trip
    // even if the redirect URL does not preserve query params.
    try {
      const pid = new URLSearchParams(window.location.search).get('project');
      if (pid) sessionStorage.setItem('hf_oauth_return_project', pid);
    } catch {}
    try {
      await loginHF(hfOAuth.clientId, hfOAuth.scopes);
    } catch {
      toast.error(t('hfSignInFailed'));
    }
  }, [hfOAuth, t]);
  const [showModeMenu, setShowModeMenu] = useState(false);
  const [interviewTemplates, setInterviewTemplates] = useState<InterviewTemplate[]>([]);
  const [interviewManagerOpen, setInterviewManagerOpen] = useState(false);
  const [interviewManagerMode, setInterviewManagerMode] = useState<'list' | 'create'>('list');
  const loadInterviewTemplates = useCallback(() => {
    interviewTemplatesService.getAllTemplates().then(setInterviewTemplates).catch(() => {});
  }, []);
  useEffect(() => {
    loadInterviewTemplates();
  }, [loadInterviewTemplates]);
  // Mobile breakpoint — the per-project model picker becomes a full-screen dialog
  // instead of an anchored popover (which can't fill a phone screen).
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, []);

  // Recomputes on modelConfigVersion changes.
  const resolvedAssignment = useMemo(
    () => resolveActiveAssignment(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modelConfigVersion],
  );
  const effectiveAgentModel = resolvedAssignment?.agent.model ?? currentModel;
  // The mic is gated on the project's dedicated voice-input slot (STT model /
  // browser / off), not the agent model's input modalities.
  const voiceInput = resolvedAssignment?.voiceInput ?? null;
  const voiceInputEnabled = voiceInput != null;
  // Browser slot records via the Web Speech API (live transcript); a model slot
  // records a clip. Either way the result becomes a pending attachment, resolved
  // to audio or transcribed text only when the message is sent.
  const voiceIsBrowser = voiceInput === 'browser';

  const MODE_CONFIG: Record<WorkspaceMode, { label: string; tip: string; Icon: typeof Code; iconColor: string }> = {
    code: { label: tc('labels.code'), tip: t('tips.modeCode'), Icon: Code, iconColor: 'text-orange-500' },
    chat: { label: tc('terms.chat'), tip: t('tips.modeChat'), Icon: MessageSquare, iconColor: 'text-green-500' },
    interview: { label: t('modeInterview'), tip: t('tips.modeInterview'), Icon: ClipboardList, iconColor: 'text-blue-500' },
  };

  // Prompt state — owned by ChatPanel, never leaves this component until submit
  const [prompt, setPrompt] = useState('');
  // A message typed before any model is connected is kept, per project, and sent once one is.
  // sessionStorage, so it survives the round trip to a provider's sign-in page in this tab.
  const heldProjectId = useWorkspaceStore(s => s.projectId);
  const heldKey = `osw_held_prompt:${heldProjectId ?? ''}`; // i18n-ignore: storage key
  const [held, setHeld] = useState<string | null>(null);
  // Whether the held message made it into storage, which is where panels claim it from.
  const heldStored = useRef(false);
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(heldKey);
      heldStored.current = stored !== null;
      setHeld(stored);
    } catch {
      setHeld(null);
    }
  }, [heldKey]);
  const holdPrompt = useCallback((text: string | null) => {
    setHeld(text);
    try {
      if (text) sessionStorage.setItem(heldKey, text);
      else sessionStorage.removeItem(heldKey);
      heldStored.current = !!text;
    } catch {
      heldStored.current = false; // kept in memory only
    }
  }, [heldKey]);
  /**
   * Text the Styles tab handed over, appended rather than sent.
   *
   * Keyed on the nonce, not the text, so asking about the same property twice appends twice. The
   * last applied nonce is a ref because both composers (the desktop tree and the mobile one) are
   * mounted at once and each has to apply it to its own draft exactly once.
   */
  const composerDraft = useWorkspaceStore(s => s.composerDraft);
  const appliedDraftRef = useRef(0);
  useEffect(() => {
    if (!composerDraft || composerDraft.nonce === appliedDraftRef.current) return;
    appliedDraftRef.current = composerDraft.nonce;
    setPrompt(prev => (prev.trim() ? `${prev.trim()}\n\n${composerDraft.text}` : composerDraft.text));
  }, [composerDraft]);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  /** Project-specific suggestions replace the generic set; blank projects fall back to generic. */
  const projectSuggestions = useWorkspaceStore(s => s.promptSuggestions);
  // `initProject` sets the id and the suggestions in one update, so an id means the list below is
  // the project's own. Before that it is the slice's empty default, which reads identically to "this
  // project has none" and would show the generic starters for a moment and then swap them out.
  const suggestionsLoaded = useWorkspaceStore(s => s.projectId) !== '';
  const allSuggestions = projectSuggestions.length > 0 ? projectSuggestions : simple ? QUICK_EDIT_PILLS : SUGGESTION_PILLS;
  // Ordered before the inline/overflow split, so a suggestion scoped to this page takes one of the
  // three inline slots ahead of the general ones.
  const suggestions = useMemo(
    () => selectPromptSuggestions(allSuggestions, previewPath ?? null),
    [allSuggestions, previewPath]
  );
  // The built-in starters are translated by id. A project's own suggestions are its owner's text and
  // are shown as stored. Typed over BuiltInPillId, so a new starter without a label fails `tsc`.
  const tPills = useTranslations('chat.pills');
  const pillLabels = useMemo<Record<BuiltInPillId, string>>(() => ({
    portfolio: tPills('portfolio'),
    'multipage-site': tPills('multipage-site'),
    'workspace-setup': tPills('workspace-setup'),
    'quick-reword': tPills('quick-reword'),
    'quick-colours': tPills('quick-colours'),
    'quick-section': tPills('quick-section'),
    'quick-mobile': tPills('quick-mobile'),
  }), [tPills]);
  const pillLabel = (pill: { id: string; label: string }) =>
    (pillLabels as Record<string, string>)[pill.id] ?? pill.label;
  const inlineSuggestions = suggestions.slice(0, INLINE_SUGGESTION_COUNT);
  const overflowSuggestions = suggestions.slice(INLINE_SUGGESTION_COUNT);

  // The one-time tip above the suggestions; see the effect below `turns`.
  const [firstPromptTip, setFirstPromptTip] = useState(false);
  const applyPromptSuggestion = useCallback((text: string) => {
    setPrompt(text);
    composerTextareaRef.current?.focus();
    // Picking a suggestion is the tip done its job.
    configManager.setFirstPromptTipDone();
    setFirstPromptTip(false);
  }, []);

  // Clear prompt when generation starts
  const prevGenerating = useRef(generating);
  if (generating && !prevGenerating.current) {
    setPrompt('');
  }
  prevGenerating.current = generating;

  // Image handling state
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  // Audio capture state — the mic shows when the project has a voice-input model.
  const [pendingAudio, setPendingAudio] = useState<PendingAudio[]>([]);
  const { isRecording, error: recError, analyser, start: startRecording, stop: stopRecording, cancel: cancelRecording } = useAudioRecorder();
  // Browser on-device STT, used when the voice-input slot is set to 'browser'.
  const speech = useSpeechRecognition();
  // Pending text-file attachments (added via the + menu); content goes to the model.
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const supportsAudio = voiceInputEnabled;

  // Handle image drop
  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.types.includes('application/semantic-block')) return;
    if (!supportsVision) return;

    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type.startsWith('image/')
    );

    if (files.length > 0) {
      track('image_attached', { source: 'drop', count: files.length });
    }

    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        setPendingImages(prev => [...prev, pendingImageFromDataUrl(reader.result as string)]);
      };
      reader.readAsDataURL(file);
    }
  }, [supportsVision]);

  // Handle drag over
  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.types.includes('application/semantic-block')) return;
    if (supportsVision) {
      setIsDragging(true);
    }
  }, [supportsVision]);

  // Handle drag leave
  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  // Handle paste
  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsVision) return;

    const items = e.clipboardData?.items;
    if (!items) return;

    let pastedCount = 0;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          pastedCount++;
          const reader = new FileReader();
          reader.onload = () => {
            setPendingImages(prev => [...prev, pendingImageFromDataUrl(reader.result as string)]);
          };
          reader.readAsDataURL(file);
        }
      }
    }
    if (pastedCount > 0) {
      track('image_attached', { source: 'paste', count: pastedCount });
    }
  }, [supportsVision]);

  // Remove a pending image
  const removeImage = useCallback((imageId: string) => {
    setPendingImages(prev => prev.filter(img => img.id !== imageId));
  }, []);

  // Start recording. Browser STT listens live; a model-backed voice slot records
  // a clip via MediaRecorder.
  const handleStartRecording = useCallback(() => {
    if (voiceIsBrowser) {
      if (!speech.supported) {
        toast.error(t('speechUnavailable'));
        return;
      }
      speech.start();
    } else {
      startRecording();
    }
  }, [voiceIsBrowser, speech, startRecording, t]);

  // Stop recording and add the result as a pending attachment. Browser keeps the
  // live transcript; a model clip is transcribed later, when the message is sent.
  const handleStopRecording = useCallback(async () => {
    if (voiceIsBrowser) {
      const text = (await speech.stop()).trim();
      if (text) {
        setPendingAudio(prev => [...prev, {
          id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          data: '', format: 'wav', durationMs: 0, transcript: text,
        }]);
      }
      return;
    }
    const clip = await stopRecording();
    if (!clip) return;
    setPendingAudio(prev => [...prev, {
      id: `aud-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
      ...clip,
    }]);
  }, [voiceIsBrowser, speech, stopRecording]);

  // Cancel an in-progress recording (browser or media).
  const handleCancelRecording = useCallback(() => {
    if (voiceIsBrowser) speech.cancel();
    else cancelRecording();
  }, [voiceIsBrowser, speech, cancelRecording]);

  const removeAudio = useCallback((id: string) => {
    setPendingAudio(prev => prev.filter(a => a.id !== id));
  }, []);

  // --- Attachments added via the + menu ---
  const addImageFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    if (files.length) track('image_attached', { source: 'picker', count: files.length });
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        setPendingImages(prev => [...prev, pendingImageFromDataUrl(reader.result as string)]);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  /** The preview, as it is right now, joins the next message the way a dropped image does. */
  const addScreenshot = useCallback(async () => {
    if (!onCaptureContextScreenshot) return;
    const dataUrl = await onCaptureContextScreenshot();
    if (!dataUrl) {
      toast.error(t('previewCaptureFailed'));
      return;
    }
    track('image_attached', { source: 'screenshot', count: 1 });
    setPendingImages(prev => [...prev, pendingImageFromDataUrl(dataUrl)]);
  }, [onCaptureContextScreenshot, t]);

  const addTextFiles = useCallback((fileList: FileList | null) => {
    if (!fileList) return;
    for (const file of Array.from(fileList)) {
      const reader = new FileReader();
      reader.onload = () => {
        setPendingFiles(prev => [...prev, {
          id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
          name: file.name,
          content: (reader.result as string) ?? '',
          size: file.size,
        }]);
      };
      reader.readAsText(file);
    }
  }, []);

  const removeFile = useCallback((id: string) => {
    setPendingFiles(prev => prev.filter(f => f.id !== id));
  }, []);

  // Handle send with attachments (text + images + audio + files)
  const handleSend = useCallback(() => {
    if (!providerReady) {
      // A held message is plain text that survives a reload; attachments can't follow it.
      if (pendingImages.length || pendingAudio.length || pendingFiles.length) {
        toast.error(t('connectBeforeAttachments'));
        return;
      }
      if (prompt.trim()) {
        holdPrompt(prompt.trim());
        setPrompt('');
      }
      return;
    }
    if (pendingAudio.length) {
      // Mirrors MultiAgentOrchestrator.execute()'s passToAgent check: the clip
      // goes to the agent as audio when the voice slot IS the agent, or is a
      // model matching the agent's provider/model. Otherwise it is transcribed,
      // either on-device (browser slot, pre-captured transcript) or via the
      // dedicated voice-input model at send time.
      const agent = resolvedAssignment?.agent;
      const passToAgent = voiceInput === 'agent'
        || !!(voiceInput && typeof voiceInput === 'object' && agent && voiceInput.provider === agent.provider && voiceInput.model === agent.model);
      const handling = passToAgent ? 'agent_audio' : (voiceIsBrowser ? 'on_device' : 'transcription');
      track('voice_input_used', { handling });
    }

    onGenerate(
      prompt,
      pendingImages.length ? pendingImages : undefined,
      pendingAudio.length ? pendingAudio : undefined,
      pendingFiles.length ? pendingFiles : undefined,
    );
    setPendingImages([]);
    setPendingAudio([]);
    setPendingFiles([]);
  }, [onGenerate, pendingImages, pendingAudio, pendingFiles, prompt, resolvedAssignment, voiceInput, voiceIsBrowser, providerReady, holdPrompt, t]);

  // Once a model is connected, the held message goes out as if it had just been sent.
  useEffect(() => {
    if (!providerReady || !held || generating) return;
    const text = held;
    // Claim it from storage first: the desktop and mobile layouts can both have a panel mounted,
    // and only the one that finds it still stored sends it.
    if (heldStored.current) {
      try {
        if (sessionStorage.getItem(heldKey) !== text) {
          setHeld(null);
          return;
        }
      } catch { /* storage went away: send the copy in memory */ }
    }
    holdPrompt(null);
    // Wait for the connect handling to settle the model, or the first request could go to a
    // model the account cannot use.
    void connectSettled().then(() => onGenerate(text));
  }, [providerReady, held, generating, holdPrompt, onGenerate, heldKey]);

  // Listen for tour event to open provider settings
  useEffect(() => {
    const handleTourOpenSettings = () => {
      setShowMobileSettings(true);
    };

    window.addEventListener('tour-open-provider-settings', handleTourOpenSettings);
    window.addEventListener(OPEN_MODEL_PICKER_EVENT, handleTourOpenSettings);
    return () => {
      window.removeEventListener('tour-open-provider-settings', handleTourOpenSettings);
      window.removeEventListener(OPEN_MODEL_PICKER_EVENT, handleTourOpenSettings);
    };
  }, []);

  const processorRef = useRef(new EventProcessor());

  // Transform events into turns with chronologically ordered items (incremental), counting the
  // person's messages as it goes.
  const { turns, requests } = useMemo(() => {
    const turns = processorRef.current.process(events);
    return { turns, requests: processorRef.current.requests };
  }, [events]);

  // A one-time tip in the empty chat for someone who has never sent a message: what a suggestion
  // does, and that nothing is sent until they press Send. Read after mount (localStorage), and done
  // with for good once a suggestion is picked, a conversation has a message, or the tip is dismissed.
  useEffect(() => {
    if (configManager.isFirstPromptTipDone()) return;
    if (turns.length > 0) {
      configManager.setFirstPromptTipDone();
      setFirstPromptTip(false);
      return;
    }
    setFirstPromptTip(true);
  }, [turns.length]);
  const dismissFirstPromptTip = useCallback(() => {
    configManager.setFirstPromptTipDone();
    setFirstPromptTip(false);
  }, []);
  // The empty-thread chooser shows the held message itself; anywhere else it sits above the composer.
  const showConnectChooser = workspaceReady && turns.length === 0 && needsConnection;

  // Pacing notice: reassure the user when a large single-file WRITE has been
  // running for a while (common on models without tool streaming).
  const [showPacingNotice, setShowPacingNotice] = useState(false);
  const isWritePacingItem = useCallback((it: PacingToolItem): boolean => {
    const cat = (it.name === 'bash' || it.name === 'shell')
      ? classifyCommand(it.command)
      : it.name;
    return cat === 'write';
  }, []);
  const pacingItems = useMemo<PacingToolItem[]>(() =>
    turns.flatMap(t => t.items)
      .filter(i => i.type === 'tool')
      .map(i => {
        const tool = i.data as ToolCall;
        return {
          type: 'tool',
          timestamp: i.timestamp,
          status: tool?.status,
          name: tool?.name,
          command: tool?.parameters?.command ?? tool?.parameters?.cmd,
        };
      }),
    [turns]);

  useEffect(() => {
    if (!generating) {
      setShowPacingNotice(false);
      return;
    }
    let mounted = true;
    const recompute = () => {
      if (!mounted) return;
      setShowPacingNotice(
        shouldShowPacingNotice(pacingItems, Date.now(), configManager.hasDismissedPacingNotice(), isWritePacingItem)
      );
    };
    recompute();
    const intervalId = setInterval(recompute, 1000);
    return () => {
      mounted = false;
      clearInterval(intervalId);
    };
  }, [generating, pacingItems, isWritePacingItem]);

  // "Why did you stop?", asked once after a stop the user made. Same shape and place as the
  // pacing notice: the newest thing in the thread, clearly not a message, one tap to answer
  // or dismiss. The ask itself is already counted (stop_reason_shown) when the store records
  // the stop, so what is tracked here is only the answer.
  const viewedProjectId = useWorkspaceStore(s => s.projectId);
  const userStop = useWorkspaceStore(s => s.userStop);
  const clearUserStop = useWorkspaceStore(s => s.clearUserStop);
  const showStopReason = shouldShowStopReason(userStop, viewedProjectId, generating);
  const answerStopReason = useCallback((reason: StopReasonId) => {
    if (userStop) track('stop_reason', { reason, task_id: userStop.taskId });
    clearUserStop();
  }, [userStop, clearUserStop]);

  const dismissPacingNotice = useCallback(() => {
    configManager.setPacingNoticeDismissed();
    setShowPacingNotice(false);
  }, []);

  // The thread follows its newest content until the person scrolls up, and again once they scroll
  // back to the bottom, send a message or open another project.
  useFollowNewest(scrollRef, { content: turns, requests, conversation: viewedProjectId, empty: turns.length === 0 });

  // Focus context snippet for unified context component
  const trimmedSnippet = focusPreviewSnippet?.trim() ?? '';
  const focusContextData = focusContext ? { domPath: focusContext.domPath, snippet: trimmedSnippet } : null;

  const nothingToSend = !prompt.trim() && pendingImages.length === 0 && pendingAudio.length === 0 && pendingFiles.length === 0;
  // What Send does, or why it is off. The tour holds the composer and says why itself.
  const sendTip = isTourLockingInput ? undefined
    : generating ? t('tips.stop')
    : !providerReady && !needsConnection ? t('tips.connectFirst')
    : nothingToSend ? t('tips.writeFirst')
    : t('tips.send', { shortcut: modShortcut('Enter') });

  // Runtime error card
  const runtimeErrorHint = !generating && runtimeErrors.length > 0 ? (
    <div
      className="rounded-md border border-dashed border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-muted-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 text-foreground">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs uppercase tracking-wide text-destructive">{t('runtimeErrors')}</span>
          <span className="inline-flex items-center justify-center rounded-full bg-destructive/15 text-destructive text-[10px] font-medium px-1.5 min-w-[18px] h-[18px]">
            {runtimeErrors.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {onClearRuntimeErrors && (
            <Tip label={t('dismissRuntimeErrors')}>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs"
                onClick={onClearRuntimeErrors}
              >
                {tc('actions.clear')}
              </Button>
            </Tip>
          )}
          {onSendRuntimeErrors && (
            <Tip label={t('sendErrorsToAi')}>
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-xs text-destructive"
                onClick={onSendRuntimeErrors}
              >
                {t('send')}
              </Button>
            </Tip>
          )}
        </div>
      </div>
      <pre className="mt-2 max-h-24 overflow-auto rounded border border-border/50 bg-background/90 px-2 py-1 text-[11px] text-foreground leading-relaxed">
        <code>{runtimeErrors.map(e => `• ${e}`).join('\n')}</code>
      </pre>
    </div>
  ) : null;

  return (
    <PanelContainer dataTourId="assistant-panel" className={className}>
      {!hideHeader && (
        <PanelHeader
          icon={MessageSquare}
          title={tc('terms.chat')}
          color="var(--button-assistant-active)"
          onClose={onClose}
          panelKey="chat"
          actions={onClearChat ? [
            { id: 'clear', icon: Trash2, label: t('clearChat'), onSelect: onClearChat, tourId: 'clear-chat-button' },
          ] : undefined}
        >
          {activeInterview && (
            <Tip label={t('tips.interviewBadge', { title: activeInterview.title })} side="bottom">
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/15 text-blue-500 text-[11px] font-medium px-2 py-0.5">
                <ClipboardList className="h-3 w-3 shrink-0" />
                <span className="truncate max-w-[12rem]">{activeInterview.title}</span>
              </span>
            </Tip>
          )}
        </PanelHeader>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4">
      <div className={cn('space-y-4', solo && 'mx-auto w-full max-w-3xl')}>
        {!workspaceReady && turns.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 p-4">
            <Loader2 className="h-5 w-5 animate-spin opacity-40" />
            <span className="text-xs">{t('loadingConversation')}</span>
          </div>
        ) : showConnectChooser ? (
          <ConnectChooser
            onMoreOptions={() => openProvidersManage('connections')}
            held={held}
            onDiscardHeld={() => holdPrompt(null)}
          />
        ) : (
          thread
        )}
        {/* Last in the list, not first: the thread appends downward and scrolls to the
            newest item, so a notice at the top is either missed or has to be scrolled back
            away from. It is about what the agent is doing right now, which is the bottom. */}
        {showPacingNotice && (
          <div role="status" aria-live="polite" className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Loader2 aria-hidden="true" className="h-3 w-3 mt-0.5 shrink-0 animate-spin opacity-60" />
            <span className="flex-1">
              {t('largeWriteNote')}
            </span>
            <Tip label={t('dismissNotice')}>
              <button
                type="button"
                onClick={dismissPacingNotice}
                aria-label={t('dismissNotice')}
                className="shrink-0 rounded p-0.5 hover:bg-muted-foreground/10"
              >
                <X className="h-3 w-3" />
              </button>
            </Tip>
          </div>
        )}
        {showStopReason && (
          <div role="group" aria-label={t('whyDidYouStop')} data-testid="stop-reason" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <div className="flex items-start gap-2">
              <span className="flex-1">{t('stopReasons.prompt')}</span>
              <Tip label={t('dismissQuestion')}>
                <button
                  type="button"
                  onClick={clearUserStop}
                  aria-label={t('dismissQuestion')}
                  className="shrink-0 rounded p-0.5 hover:bg-muted-foreground/10"
                >
                  <X className="h-3 w-3" />
                </button>
              </Tip>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {STOP_REASONS.map(id => (
                <button
                  key={id}
                  type="button"
                  onClick={() => answerStopReason(id)}
                  className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground hover:bg-primary/15 hover:text-primary"
                >
                  {t(`stopReasons.${id}`)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      </div>

      {held && !showConnectChooser && (
        <div className={cn('px-3 pt-3', solo && 'mx-auto w-full max-w-3xl')}>
          <div className="flex flex-col gap-1 rounded-lg border border-border bg-muted/40 px-3 py-2">
            <p className="line-clamp-3 whitespace-pre-wrap text-sm text-foreground">{held}</p>
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{tConnect('held')}</span>
              <button type="button" onClick={() => holdPrompt(null)} className="underline hover:text-foreground">{tConnect('discard')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Input — or composerOverlay when present */}
      {composerOverlay ? (
        <div className={cn('p-3', solo && 'mx-auto w-full max-w-3xl')}>{composerOverlay}</div>
      ) : (
      <div className={cn('p-3 space-y-2', solo && 'mx-auto w-full max-w-3xl')}>
        {runtimeErrorHint}
        {/* Hidden inputs driven by the + attach menu */}
        <input
          ref={imageInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => { addImageFiles(e.target.files); e.target.value = ''; }}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.markdown,.json,.csv,.tsv,.js,.jsx,.ts,.tsx,.html,.css,.scss,.xml,.yml,.yaml,.py,.rb,.go,.rs,.java,.c,.cpp,.h,.sh,.sql,.log,.env,text/*"
          multiple
          className="hidden"
          onChange={(e) => { addTextFiles(e.target.files); e.target.value = ''; }}
        />
        {/* Quick-start suggestions live in the context area above the input. Adding context
            (focus, images, files) grows MessageContext below and bumps these up. Shown only for
            a fresh, connected, idle composer (not interview or recording). */}
        {((providerReady || hasAnyConnectedProvider()) && (simple || turns.length === 0) && !generating && mode !== 'interview' && !isRecording && !speech.isListening && suggestionsLoaded) && (
          <div className="relative">
            {/* The app's tooltip (`components/ui/tooltip.tsx`), held open and pointing at the
                suggestions until dismissed. It floats over the empty chat rather than pushing the
                composer down. */}
            {firstPromptTip && inlineSuggestions.length > 0 && (
              <div
                role="note"
                className="absolute bottom-full left-0 z-20 mb-2 flex max-w-[300px] items-start gap-2 rounded-md border border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))] px-3 py-1.5 text-xs text-primary shadow-md animate-in fade-in-0"
              >
                <p className="flex-1 leading-snug text-balance">{t('firstPromptTip')}</p>
                <Tip label={t('firstPromptTipDismiss')}>
                  <button
                    type="button"
                    onClick={dismissFirstPromptTip}
                    aria-label={t('firstPromptTipDismiss')}
                    className="-mr-1 shrink-0 rounded p-0.5 opacity-80 hover:opacity-100"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </Tip>
                <span aria-hidden="true" className="absolute top-full left-5 size-2.5 -translate-y-1/2 rotate-45 rounded-[2px] border-r border-b border-primary/40 bg-[color-mix(in_oklab,var(--primary)_15%,var(--popover))]" />
              </div>
            )}
            {inlineSuggestions.length > 0 && (
              <div className="text-xs text-muted-foreground mb-1.5">{t('tryOneOfThese')}</div>
            )}
            <div className="flex flex-wrap gap-1.5">
              {inlineSuggestions.map((pill) => (
                <Tip key={pill.id} label={pill.prompt !== pillLabel(pill) ? pill.prompt : undefined}>
                  <button
                    type="button"
                    onClick={() => applyPromptSuggestion(pill.prompt)}
                    className="text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 cursor-pointer transition-all"
                  >
                    {pillLabel(pill)}
                  </button>
                </Tip>
              ))}
              {/* Always rendered, even with nothing overflowing: it is the only route from the
                  composer to where these are edited. */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Tip label={overflowSuggestions.length > 0 ? t('moreSuggestions', { count: overflowSuggestions.length }) : t('manageSuggestions')}>
                    <button
                      type="button"
                      aria-label={
                        overflowSuggestions.length > 0
                          ? t('moreSuggestions', { count: overflowSuggestions.length })
                          : t('manageSuggestions')
                      }
                      className="text-xs px-3 py-1.5 rounded border border-border text-muted-foreground hover:text-foreground hover:border-foreground/30 cursor-pointer transition-all"
                    >
                      …
                    </button>
                  </Tip>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-w-xs">
                  {overflowSuggestions.map((pill) => (
                    <DropdownMenuItem
                      key={pill.id}
                      onClick={() => applyPromptSuggestion(pill.prompt)}
                      className="text-xs"
                    >
                      {pillLabel(pill)}
                    </DropdownMenuItem>
                  ))}
                  {overflowSuggestions.length > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    className="text-xs"
                    onClick={() =>
                      useWorkspaceStore
                        .getState()
                        .setShowProjectSettingsModal(true, 'project-settings-suggestions')
                    }
                  >
                    <Settings2 className="h-3.5 w-3.5 mr-2" />
                    {t('manageSuggestions')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}
        {/* Unified context component — focus, blocks, images, files, voice */}
        <MessageContext
          focusContext={focusContextData}
          semanticBlocks={placedBlocks}
          images={pendingImages}
          files={pendingFiles}
          audioClips={pendingAudio}
          systemNote={systemNote}
          onClearFocus={onClearFocus}
          onRemoveBlock={onRemovePlacedBlock}
          onClearBlocks={onClearPlacedBlocks}
          onRemoveImage={removeImage}
          onClearImages={() => setPendingImages([])}
          onRemoveFile={removeFile}
          onClearFiles={() => setPendingFiles([])}
          onRemoveAudio={removeAudio}
          onClearAudio={() => setPendingAudio([])}
        />
        {recError && !isRecording && (
          <p className="text-xs text-destructive">{t(`recording.${recError}`)}</p>
        )}
        <ApprovalCard />
        {/* Modality indicators */}
        <div className="flex !mb-0">
          {[
            { key: 'text', icon: Type, label: t('textInput'), enabled: true },
            { key: 'image', icon: ImageIcon, label: inputModalities.includes('image') ? t('imageInputOn') : t('imageInputOff'), enabled: inputModalities.includes('image') },
            { key: 'audio', icon: Mic, label: voiceInputEnabled ? t('voiceInputOn') : t('voiceInputOff'), enabled: voiceInputEnabled },
          ].map((mod, i, arr) => (
            <Tip key={mod.key} label={mod.label}>
              <div
                className={`flex items-center gap-1 px-2.5 py-1 border border-b-0 border-border text-xs cursor-default transition-colors ${
                  mod.enabled ? 'text-foreground bg-card' : 'text-muted-foreground/30'
                } ${i === 0 ? 'rounded-tl-lg' : ''} ${i === arr.length - 1 ? 'rounded-tr-lg' : ''}`}
              >
                <mod.icon className="h-3 w-3" />
              </div>
            </Tip>
          ))}
          {!simple && (
            <div className="ml-auto flex items-center">
              <PermissionModeSelector />
            </div>
          )}
        </div>
        <div
          className={`bg-card border shadow-sm overflow-hidden transition-all ${
            isDragging ? 'border-primary border-2 bg-primary/5' : 'border-border'
          }`}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
        >

          {/* Drop overlay */}
          {isDragging && supportsVision && (
            <div className="absolute inset-0 flex items-center justify-center bg-primary/10 z-10 pointer-events-none">
              <div className="text-primary font-medium flex items-center gap-2">
                <ImageIcon className="h-5 w-5" />
                {t('dropImageHere')}
              </div>
            </div>
          )}

          {mode === 'interview' && !activeInterview ? (
            <InterviewPicker
              templates={interviewTemplates}
              onStart={onStartInterview}
              disabled={!providerReady}
              {...(simple ? {} : {
                // Editing the templates is the Interviews page, which the simple menu does not
                // list; offering it from here would put it back.
                onManage: () => { setInterviewManagerMode('list'); setInterviewManagerOpen(true); },
                onNew: () => { setInterviewManagerMode('create'); setInterviewManagerOpen(true); },
              })}
            />
          ) : (isRecording || speech.isListening) ? (
            <div className="flex items-center gap-3 px-3 py-3">
              <span className="h-2.5 w-2.5 rounded-full bg-primary animate-pulse shrink-0" />
              {voiceIsBrowser ? (
                <span className="flex-1 min-w-0 truncate text-sm text-muted-foreground">
                  {speech.interim || t('listening')}
                </span>
              ) : (
                <AudioSpectrogram analyser={analyser} className="flex-1 min-w-0" />
              )}
              <Button variant="ghost" size="sm" onClick={handleCancelRecording} className="shrink-0">
                {tc('actions.cancel')}
              </Button>
              <Button size="sm" onClick={handleStopRecording} className="shrink-0 gap-1.5">
                <Square className="h-3.5 w-3.5" />
                {t('stop')}
              </Button>
            </div>
          ) : (
          <div className="relative flex bg-card rounded-lg transition-all">
              <Textarea
                ref={composerTextareaRef}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (isTourLockingInput) {
                    return;
                  }
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                onPaste={handlePaste}
                placeholder={!providerReady && !needsConnection ? t('placeholder.selectProvider') : simple ? t('placeholder.askForChange') : supportsVision ? t('placeholder.describeWithImages') : t('placeholder.describe')}
                className="flex-1 px-3 py-2 bg-transparent border-0 resize-none focus:outline-none text-sm placeholder:text-muted-foreground text-foreground"
                rows={3}
                disabled={generating || isTourLockingInput || (!providerReady && !needsConnection)}
              />
              <div className="flex flex-col p-2 gap-2">
                <Tip label={sendTip} wrapClassName="grid">
                <Button
                  onClick={generating ? onStop : handleSend}
                  disabled={isTourLockingInput ? !generating : (!generating && (nothingToSend || (!providerReady && !needsConnection)))}
                  size="sm"
                  className="flex items-center gap-2"
                >
                  {generating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {t('stop')}
                    </>
                  ) : (
                    <>
                      <Send className="h-4 w-4" />
                      {t('send')}
                    </>
                  )}
                </Button>
                </Tip>
                {!generating && (
                  <div className="flex items-center gap-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Tip label={t('addAttachment')} wrapClassName="flex-1 grid">
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={isTourLockingInput || !providerReady}
                            aria-label={t('addAttachment')}
                            className="flex-1"
                          >
                            <Plus className="h-4 w-4" />
                          </Button>
                        </Tip>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" side="top">
                        <DropdownMenuItem
                          disabled={!supportsVision}
                          onSelect={() => setTimeout(() => imageInputRef.current?.click(), 0)}
                        >
                          <ImageIcon className="h-4 w-4" />
                          {t('attachImage')}
                          {!supportsVision && <span className="ml-auto text-xs text-muted-foreground">{t('unsupported')}</span>}
                        </DropdownMenuItem>
                        {onCaptureContextScreenshot && (
                          <DropdownMenuItem disabled={!supportsVision} onSelect={() => { void addScreenshot(); }}>
                            <Camera className="h-4 w-4" />
                            {t('attachScreenshot')}
                            {!supportsVision && <span className="ml-auto text-xs text-muted-foreground">{t('unsupported')}</span>}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem onSelect={() => setTimeout(() => fileInputRef.current?.click(), 0)}>
                          <FileText className="h-4 w-4" />
                          {t('textFile')}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                    {supportsAudio && (
                      <Tip label={t('recordVoice')} wrapClassName="flex-1 grid">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={handleStartRecording}
                          disabled={isTourLockingInput || !providerReady}
                          aria-label={t('recordVoice')}
                          className="flex-1"
                        >
                          <Mic className="h-4 w-4" />
                        </Button>
                      </Tip>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Footer: the model picker and the Code/Chat/Interview menu. */}
          <div className="border-t border-border bg-muted/50 px-2 py-2">
            <div className="flex items-center justify-between gap-2">
              {/* Blurred backdrop behind the per-project model popover (Radix Popover
                  has no overlay of its own), matching the drawer/dialog treatment. */}
              {!isMobile && showMobileSettings && typeof document !== 'undefined' && createPortal(
                <div
                  className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
                  aria-hidden="true"
                  onClick={() => setShowMobileSettings(false)}
                />,
                document.body,
              )}
              {!providerReady && !hasAnyConnectedProvider() && hfOAuth?.oauthAvailable && hfOAuth.clientId ? (
                /* HF Space, no provider connected: one-click "Sign in with HuggingFace"
                   OAuth (primary) with a chevron that opens the Connections tab (the
                   default unconnected behavior). Not wrapped in the model-picker
                   Popover, since it has its own two actions. */
                <div
                  className="flex items-center h-7 rounded-full overflow-hidden bg-background dark:bg-input/30 border border-primary ring-2 ring-primary/70 animate-ring-opacity"
                  data-tour-id="provider-settings-trigger"
                >
                  <button
                    type="button"
                    onClick={handleHFSignIn}
                    aria-label={t('signInWithHF')}
                    className="flex items-center gap-1.5 h-full px-2 text-foreground text-xs font-medium transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50"
                  >
                    <LogIn className="h-3.5 w-3.5" />
                    {t('signInWithHF')}
                  </button>
                  <Tip label={tc('labels.connectionOptions')}>
                    <button
                      type="button"
                      onClick={() => openProvidersManage('connections')}
                      aria-label={tc('labels.connectionOptions')}
                      className="h-full px-1.5 border-l border-border text-foreground transition-colors hover:bg-accent hover:text-accent-foreground dark:hover:bg-input/50 flex items-center group/chev"
                    >
                      <ChevronUp className="h-3.5 w-3.5 transition-transform group-hover/chev:-translate-y-0.5" />
                    </button>
                  </Tip>
                </div>
              ) : (
              <Popover
                open={!isMobile && showMobileSettings}
                onOpenChange={(open) => {
                  if (open && !hasAnyConnectedProvider()) {
                    // No providers connected — the picker would be empty. Open the
                    // Connections tab of the full manager instead.
                    openProvidersManage('connections');
                    return;
                  }
                  setShowMobileSettings(open);
                }}
              >
                <PopoverTrigger asChild>
                  <Tip label={showMobileSettings ? undefined : providerReady ? t('modelsThisProject') : t('tips.connect')}>
                  <Button
                    variant="outline"
                    size="sm"
                    className={`h-7 p-0 gap-0 overflow-hidden text-xs ${!providerReady ? 'ring-2 ring-primary/70 animate-ring-opacity border-primary' : ''} ${!isMobile && showMobileSettings ? 'relative z-50' : ''}`}
                    data-tour-id="provider-settings-trigger"
                  >
                    <span className="flex items-center h-full px-2">
                      {providerReady ? (isFreeModels(effectiveAgentModel) ? tModels('freeModels') : getModelDisplayName(effectiveAgentModel)) : t('selectProvider')}
                    </span>
                    <span className="flex items-center h-full px-1.5 border-l border-border group/chev">
                      {showMobileSettings
                        ? <ChevronDown className="h-3 w-3 transition-transform group-hover/chev:translate-y-0.5" />
                        : <ChevronUp className="h-3 w-3 transition-transform group-hover/chev:-translate-y-0.5" />}
                    </span>
                  </Button>
                  </Tip>
                </PopoverTrigger>
                <PopoverContent
                  side="top"
                  align="start"
                  sideOffset={6}
                  className="p-0 w-[460px] max-w-[calc(100vw-2rem)] max-h-[min(680px,var(--radix-popover-content-available-height))] overflow-hidden flex flex-col"
                  data-tour-id="provider-settings-popup"
                  onInteractOutside={(e) => {
                    // Don't dismiss while the shared model drawer (a separate fixed
                    // layer) is in use — interacting with it isn't an outside click.
                    const original = (e as unknown as { detail?: { originalEvent?: Event } }).detail?.originalEvent;
                    const target = (original?.target ?? e.target) as Element | null;
                    if (target?.closest?.('[data-models-drawer]')) e.preventDefault();
                  }}
                >
                  <ProjectModelsPanel
                    onManageSettings={() => {
                      setShowMobileSettings(false);
                      openProvidersManage('connections');
                    }}
                  />
                </PopoverContent>
              </Popover>
              )}

              {/* Mobile: the per-project picker as a full-screen dialog (the anchored
                  popover can't fill a phone screen). */}
              {isMobile && (
                <Dialog open={showMobileSettings} onOpenChange={setShowMobileSettings}>
                  <DialogContent showCloseButton className="p-0 gap-0 w-[calc(100vw-1.5rem)] max-w-none h-[calc(100dvh-1.5rem)] max-h-none overflow-hidden flex flex-col">
                    <DialogTitle className="sr-only">{t('modelsThisProject')}</DialogTitle>
                    <ProjectModelsPanel
                      onManageSettings={() => {
                        setShowMobileSettings(false);
                        openProvidersManage('connections');
                      }}
                      onDone={() => setShowMobileSettings(false)}
                    />
                  </DialogContent>
                </Dialog>
              )}

              {/* Full settings manager, opened in-workspace from the per-project panel. It is
                  non-modal so the body-portaled drawer stays usable; see UnifiedSettingsModal. */}
              <UnifiedSettingsModal
                open={showSettingsManage}
                onOpenChange={setShowSettingsManage}
                initialPane={settingsManagePane}
              />

              <InterviewTemplatesManager
                open={interviewManagerOpen}
                onOpenChange={setInterviewManagerOpen}
                initialMode={interviewManagerMode}
                onChanged={loadInterviewTemplates}
              />

              {/* Offered in the simple view too: the mode is the agent's, and quick edit is a
                  separate field now, so picking one no longer takes the surface away. */}
              {!hideHeader && (() => {
                const active = MODE_CONFIG[mode];
                const ActiveIcon = active.Icon;
                return (
                  <Popover open={showModeMenu} onOpenChange={setShowModeMenu}>
                    <PopoverTrigger asChild>
                      <Tip label={showModeMenu ? undefined : active.tip} align="end">
                        <Button variant="outline" size="sm" className="h-7 p-0 gap-0 overflow-hidden text-xs">
                          <span className="flex items-center gap-2 h-full px-2">
                            <ActiveIcon className={`h-3 w-3 ${active.iconColor}`} />
                            {active.label}
                          </span>
                          <span className="flex items-center h-full px-1.5 border-l border-border group/chev">
                            {showModeMenu
                              ? <ChevronDown className="h-3 w-3 transition-transform group-hover/chev:translate-y-0.5" />
                              : <ChevronUp className="h-3 w-3 transition-transform group-hover/chev:-translate-y-0.5" />}
                          </span>
                        </Button>
                      </Tip>
                    </PopoverTrigger>
                    <PopoverContent className="w-40 p-1" align="end" side="top">
                      {(['code', 'chat', 'interview'] as WorkspaceMode[]).map((m) => {
                        const cfg = MODE_CONFIG[m];
                        const Icon = cfg.Icon;
                        return (
                          <Tip key={m} label={cfg.tip} side="left">
                            <button
                              onClick={() => { setMode(m); setShowModeMenu(false); }}
                              className={`flex items-center gap-2 w-full text-left text-xs px-2 py-1.5 rounded hover:bg-muted ${m === mode ? 'font-semibold bg-muted/50' : ''}`}
                            >
                              <Icon className={`h-3 w-3 ${cfg.iconColor}`} />
                              {cfg.label}
                            </button>
                          </Tip>
                        );
                      })}
                    </PopoverContent>
                  </Popover>
                );
              })()}
            </div>
          </div>
        </div>
      </div>
      )}
    </PanelContainer>
  );
}
