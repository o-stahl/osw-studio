'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { GUIDED_TOUR_STEPS } from './steps';
import {
  GuidedTourEventHandler,
  GuidedTourStepContent,
  GuidedTourTranscriptEvent,
} from './types';
import { Project } from '@/lib/vfs/types';
import { runGuidedDemoEdit, runGuidedFocusDemo } from './demo-runner';
import { checkpointManager } from '@/lib/vfs/checkpoint';
import { saveManager } from '@/lib/vfs/save-manager';
import { track } from '@/lib/telemetry';

interface TourWorkspaceData {
  projectId: string | null;
  preCheckpointId: string | null;
  postCheckpointId: string | null;
  originalCss: string | null;
  updatedCss: string | null;
}

interface GuidedTourState {
  status: 'idle' | 'running' | 'completed';
  stepIndex: number;
  stepKey: number;
  currentStep?: GuidedTourStepContent;
  transcript: GuidedTourTranscriptEvent[];
  isBusy: boolean;
  projectList: Project[];
  tourDemoProjectId: string | null;
}

interface GuidedTourContextValue {
  state: GuidedTourState;
  start: () => void;
  skip: () => void;
  next: () => void;
  previous: () => void;
  setProjectList: (projects: Project[]) => void;
  setActiveProjectId: (projectId: string | null) => void;
  setTranscript: React.Dispatch<React.SetStateAction<GuidedTourTranscriptEvent[]>>;
  setWorkspaceHandler: (handler: GuidedTourEventHandler | null) => void;
  setTourDemoProjectId: (projectId: string | null) => void;
}

const GuidedTourContext = createContext<GuidedTourContextValue | null>(null);

function getStepByIndex(index: number): GuidedTourStepContent | undefined {
  if (index < 0 || index >= GUIDED_TOUR_STEPS.length) {
    return undefined;
  }
  return GUIDED_TOUR_STEPS[index];
}

export function GuidedTourProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<'idle' | 'running' | 'completed'>('idle');
  const [stepIndex, setStepIndex] = useState(0);
  const [stepKey, setStepKey] = useState(0);
  const [transcript, setTranscript] = useState<GuidedTourTranscriptEvent[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [projectList, setProjectList] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [tourDemoProjectId, setTourDemoProjectId] = useState<string | null>(null);
  const [workspaceData, setWorkspaceData] = useState<TourWorkspaceData>({
    projectId: null,
    preCheckpointId: null,
    postCheckpointId: null,
    originalCss: null,
    updatedCss: null,
  });
  const workspaceDataRef = useRef(workspaceData);

  const workspaceEditRunKey = useRef<number | null>(null);
  const focusDemoRunKey = useRef<number | null>(null);
  const checkpointRunKey = useRef<number | null>(null);
  const clearConversationRunKey = useRef<number | null>(null);
  const demoAbortController = useRef<AbortController | null>(null);
  const workspaceHandlerRef = useRef<GuidedTourEventHandler | null>(null);

  const currentStep = useMemo(() => getStepByIndex(stepIndex), [stepIndex]);

  const resetWorkspaceData = useCallback(() => {
    setWorkspaceData({
      projectId: null,
      preCheckpointId: null,
      postCheckpointId: null,
      originalCss: null,
      updatedCss: null,
    });
    workspaceEditRunKey.current = null;
    focusDemoRunKey.current = null;
    checkpointRunKey.current = null;
    clearConversationRunKey.current = null;
  }, []);

  const start = useCallback(async () => {
    // Allow restarting the tour from any state
    if (status === 'running') {
      setStatus('idle');
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    track('tour_started');

    try {
      // Create a fresh demo project for the tour
      const { vfs } = await import('@/lib/vfs');
      const { createProjectFromTemplate, loadBuiltInProjectTemplate } = await import(
        '@/lib/vfs/project-templates'
      );

      await vfs.init();

      const demo = await loadBuiltInProjectTemplate('demo');
      const tourDemo = await vfs.createProject(
        'Example Studios (Tour)',
        'Demo project for guided tour'
      );
      await createProjectFromTemplate(vfs, tourDemo.id, demo, demo.assets);

      // Store the demo project ID
      setTourDemoProjectId(tourDemo.id);

      // Get updated project list directly from VFS and update context
      const allProjects = await vfs.listProjects();
      setProjectList(allProjects);

      // Also dispatch event to update ProjectManager UI
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('projectsChanged'));
      }

      // Wait a bit to ensure state updates propagate
      await new Promise(resolve => setTimeout(resolve, 100));

      // Start the tour
      setStatus('running');
      setStepIndex(0);
      setStepKey((key) => key + 1);
      setTranscript([]);
      resetWorkspaceData();
    } catch (error) {
      console.error('[Tour] Failed to create demo project:', error);
      // Still start the tour even if demo creation fails
      setStatus('running');
      setStepIndex(0);
      setStepKey((key) => key + 1);
      setTranscript([]);
      resetWorkspaceData();
    }
  }, [resetWorkspaceData, status]);

  const setWorkspaceHandler = useCallback((handler: GuidedTourEventHandler | null) => {
    workspaceHandlerRef.current = handler;
  }, []);

  // Automatic tour start is now handled by the project manager
  // to ensure a demo project is created first if needed

  useEffect(() => {
    workspaceDataRef.current = workspaceData;
  }, [workspaceData]);

  const completeTour = useCallback(async (mode: 'finish' | 'skip' = 'finish') => {
    if (mode === 'finish') {
      track('tour_completed');
    } else {
      track('tour_abandoned', { step: stepIndex });
    }

    const currentData = workspaceDataRef.current;
    if (currentData.projectId && currentData.preCheckpointId && currentData.postCheckpointId) {
      saveManager
        .runWithSuppressedDirty(currentData.projectId, async () => {
          await checkpointManager.restoreCheckpoint(currentData.preCheckpointId!);
        })
        .then(() => {
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('filesChanged'));
          }
        })
        .catch((error) => {
          console.error('[GuidedTour] Failed to restore baseline during cleanup', error);
        });
    }

    // Smart cleanup: Remove tour demo project if other projects exist
    if (tourDemoProjectId) {
      try {
        // Fetch fresh project list from VFS to ensure we have current state
        const { vfs } = await import('@/lib/vfs');
        await vfs.init();
        const allProjects = await vfs.listProjects();

        // Check if there are other projects besides the tour demo
        const otherProjects = allProjects.filter(p => p.id !== tourDemoProjectId);

        if (otherProjects.length > 0) {
          // Delete the tour demo project since user has other projects. In server mode it was
          // pushed while open, so the server's copy goes too, or the next pull brings it back.
          await vfs.deleteProject(tourDemoProjectId);
          const { autoDeleteProject } = await import('@/lib/vfs/auto-sync');
          await autoDeleteProject(tourDemoProjectId);

          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('projectsChanged'));
            // Navigate back to project page after deleting
            window.dispatchEvent(new CustomEvent('tour-navigate-home'));
          }
        }
      } catch (error) {
        console.error('[GuidedTour] Failed to cleanup tour demo project', error);
      }
    }

    resetWorkspaceData();
    setTranscript([]);
    setStepIndex(0);
    setStepKey((key) => key + 1);
    setStatus(mode === 'finish' ? 'completed' : 'idle');
    demoAbortController.current?.abort();
    workspaceHandlerRef.current = null;
  }, [resetWorkspaceData, tourDemoProjectId, projectList, stepIndex]);

  const skip = useCallback(() => {
    completeTour('skip');
  }, [completeTour]);

  const next = useCallback(() => {
    setStepIndex((index) => {
      const nextIndex = index + 1;
      if (nextIndex >= GUIDED_TOUR_STEPS.length) {
        completeTour();
        return index;
      }

      // Auto-navigate to tour demo project when entering workspace
      const nextStep = GUIDED_TOUR_STEPS[nextIndex];
      if (nextStep?.location === 'workspace' && tourDemoProjectId) {
        // Delay slightly to ensure smooth transition
        setTimeout(() => {
          setActiveProjectId(tourDemoProjectId);
        }, 100);
      }

      setStepKey((key) => key + 1);
      return nextIndex;
    });
  }, [completeTour, tourDemoProjectId]);

  const previous = useCallback(() => {
    setStepIndex((index) => {
      const prevIndex = Math.max(0, index - 1);
      if (prevIndex !== index) {
        setStepKey((key) => key + 1);
      }
      return prevIndex;
    });
  }, []);

  // Teardown controller on unmount or when tour stops
  useEffect(() => {
    if (status !== 'running') {
      demoAbortController.current?.abort();
      demoAbortController.current = null;
    }
  }, [status]);

  // Run scripted workspace edit when reaching that step
  useEffect(() => {
    if (status !== 'running') return;
    const step = currentStep;
    if (!step) return;

    if (step.id === 'workspace-edit') {
      if (!activeProjectId) {
        return;
      }
      if (workspaceEditRunKey.current === stepKey) {
        return;
      }
      workspaceEditRunKey.current = stepKey;
      setIsBusy(true);
      setTranscript([]);

      const controller = new AbortController();
      demoAbortController.current?.abort();
      demoAbortController.current = controller;

      runGuidedDemoEdit({
        projectId: activeProjectId,
        emit: (event) => {
          setTranscript((prev) => [...prev, event]);
        },
        onWorkspaceEvent: (event) => workspaceHandlerRef.current?.(event),
        signal: controller.signal,
      })
        .then((data) => {
          setWorkspaceData((prev) => ({
            ...prev,
            projectId: activeProjectId,
            preCheckpointId: data.preChangeCheckpointId,
            postCheckpointId: data.postChangeCheckpointId,
            originalCss: data.originalCss,
            updatedCss: data.updatedCss,
          }));
        })
        .catch((error) => {
          if (error?.message !== 'aborted') {
            console.error('[GuidedTour] Demo run failed', error);
          }
        })
        .finally(() => {
          if (demoAbortController.current === controller) {
            demoAbortController.current = null;
          }
          setIsBusy(false);
        });
      return () => {
        controller.abort();
      };
    }

    if (step.id === 'workspace-focus') {
      if (focusDemoRunKey.current === stepKey) {
        return;
      }
      focusDemoRunKey.current = stepKey;
      setIsBusy(true);
      
      const controller = new AbortController();
      demoAbortController.current?.abort();
      demoAbortController.current = controller;
      
      runGuidedFocusDemo({
        signal: controller.signal,
      })
        .catch((error) => {
          if (error?.message !== 'aborted') {
            console.error('[GuidedTour] Focus demo failed', error);
          }
        })
        .finally(() => {
          if (demoAbortController.current === controller) {
            demoAbortController.current = null;
          }
          setIsBusy(false);
        });
      
      return () => {
        controller.abort();
      };
    }

    if (step.id === 'workspace-checkpoint') {
      if (!workspaceData.projectId || !workspaceData.preCheckpointId) {
        return;
      }
      if (checkpointRunKey.current === stepKey) {
        return;
      }
      checkpointRunKey.current = stepKey;
      setIsBusy(true);
      (async () => {
        try {
          await saveManager.runWithSuppressedDirty(workspaceData.projectId!, async () => {
            await checkpointManager.restoreCheckpoint(workspaceData.preCheckpointId!);
          });
          if (typeof window !== 'undefined') {
            window.dispatchEvent(new CustomEvent('filesChanged'));
          }
          setWorkspaceData((prev) => ({
            ...prev,
            postCheckpointId: null,
          }));
          const message = {
            id: `restore-${Date.now()}`,
            role: 'assistant' as const,
            tone: 'info' as const,
            content: 'Restored the checkpoint from before the color change so you can compare both versions.',
          };
          setTranscript((prev) => [...prev, message]);
          workspaceHandlerRef.current?.(message);
        } catch (error) {
          console.error('[GuidedTour] Failed to restore checkpoint', error);
        } finally {
          setIsBusy(false);
        }
      })();
    }

    if (step.id === 'clear-conversation') {
      if (clearConversationRunKey.current === stepKey) {
        return;
      }
      clearConversationRunKey.current = stepKey;
      
      // Send clear event to workspace to clear its messages
      const clearEvent = {
        id: `clear-conversation-${Date.now()}`,
        role: 'clear' as const,
        action: 'conversation' as const,
      };
      workspaceHandlerRef.current?.(clearEvent);
      
      // Clear the tour transcript as well
      setTranscript([]);
      
      // Add a brief message to show the clearing happened
      const message = {
        id: `clear-message-${Date.now()}`,
        role: 'assistant' as const,
        tone: 'info' as const,
        content: 'Conversation cleared. The agent now has a fresh start without the previous task history.',
      };
      
      setTimeout(() => {
        setTranscript([message]);
        workspaceHandlerRef.current?.(message);
        // Clear it again after showing the message briefly
        setTimeout(() => {
          setTranscript([]);
        }, 2000);
      }, 100);
    }
  }, [status, currentStep, stepKey, activeProjectId, workspaceData]);

  // Reset helpers when step changes away
  useEffect(() => {
    if (currentStep?.id !== 'workspace-edit') {
      demoAbortController.current?.abort();
      demoAbortController.current = null;
    }
  }, [currentStep]);

  const value = useMemo<GuidedTourContextValue>(
    () => ({
      state: {
        status,
        stepIndex,
        stepKey,
        currentStep,
        transcript,
        isBusy,
        projectList,
        tourDemoProjectId,
      },
      start,
      skip,
      next,
      previous,
      setProjectList: (projects: Project[]) => {
        setProjectList(projects);
      },
      setActiveProjectId,
      setTranscript,
      setWorkspaceHandler,
      setTourDemoProjectId,
    }),
    [status, stepIndex, stepKey, currentStep, transcript, isBusy, projectList, tourDemoProjectId, start, skip, next, previous, setWorkspaceHandler]
  );

  return (
    <GuidedTourContext.Provider value={value}>
      {children}
    </GuidedTourContext.Provider>
  );
}

export function useGuidedTour(): GuidedTourContextValue {
  const ctx = useContext(GuidedTourContext);
  if (!ctx) {
    throw new Error('useGuidedTour must be used within a GuidedTourProvider');
  }
  return ctx;
}
