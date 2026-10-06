import React from 'react';

export type GuidedTourStepId =
  | 'welcome'
  | 'projects-overview'
  | 'create-project'
  | 'project-controls'
  | 'edit-project'
  | 'workspace-overview'
  | 'workspace-edit'
  | 'workspace-focus'
  | 'workspace-checkpoint'
  | 'clear-conversation'
  | 'provider-settings';

type StepLocation = 'global' | 'project-manager' | 'workspace' | 'settings';

export interface GuidedTourStepContent {
  id: GuidedTourStepId;
  title: string;
  body: React.ReactNode;
  location: StepLocation;
  target?: string;
  primaryLabel?: string;
  secondaryLabel?: string;
  showBack?: boolean;
  autoAdvanceMs?: number;
  hideNav?: boolean;
}

export type GuidedTourTranscriptEvent =
  | {
      id: string;
      role: 'system' | 'user' | 'assistant';
      content: string;
      tone?: 'plan' | 'success' | 'info';
      checkpointId?: string;
    }
  | {
      id: string;
      role: 'tool';
      name: string;
      command: string;
      output: string;
    }
  | {
      id: string;
      role: 'clear';
      action: 'conversation';
    };

export type GuidedTourEventHandler = (event: GuidedTourTranscriptEvent) => void;
