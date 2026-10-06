import React from 'react';
import { GuidedTourStepContent } from './types';

export const GUIDED_TOUR_STEPS: GuidedTourStepContent[] = [
  {
    id: 'welcome',
    title: 'Welcome to Open Source Web Studio',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Let's take a guided tour of the workspace so you can see how projects, agents, and saves all fit together.</p>
        <p>The tour takes under two minutes and you can skip at any time.</p>
      </div>
    ),
    location: 'project-manager',
    primaryLabel: 'Start tour',
    secondaryLabel: 'Skip',
  },
  {
    id: 'projects-overview',
    title: 'Projects at a Glance',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>This is your project gallery. Recent work appears here with quick actions for opening, duplicating, or exporting.</p>
        <p>I've loaded a demo project so you can explore without setting anything up.</p>
      </div>
    ),
    location: 'project-manager',
    target: '[data-tour-id="projects-list"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'create-project',
    title: 'Creating a Project',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Use the New Project button to start fresh. The dialog lets you name the project and add an optional description.</p>
      </div>
    ),
    location: 'project-manager',
    target: '[data-tour-id="new-project-button"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'project-controls',
    title: 'Exporting a Project',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>Click the dropdown menu on any project card to access export options. You can export as a ZIP for deployment or JSON for backup.</p>
        <p>Projects can also be duplicated or deleted from this menu.</p>
      </div>
    ),
    location: 'project-manager',
    target: '[data-tour-id="project-export-json"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'edit-project',
    title: 'Editing a Project',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>To get to the workspace and start editing, simply click on the project card. This will open the full development environment.</p>
        <p>Click Next to enter the workspace and continue the tour.</p>
      </div>
    ),
    location: 'project-manager',
    target: '[data-tour-id="project-card"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'workspace-overview',
    title: 'Workspace Layout',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>The workspace is made of panels: the assistant conversation, the live preview and your editor tabs. The rail on the left opens more, such as the file explorer.</p>
        <p>The files work like a project file tree—add HTML, CSS, JS, or assets and the agent can edit them just like local files.</p>
      </div>
    ),
    location: 'workspace',
    target: '[data-tour-id="workspace-panels"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'workspace-edit',
    title: 'See the Agent in Action',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>I'll request the agent to change the color of "Our Services" button to a green accent and the agent performs the task.</p>
        <p>This mimics what you will see when asking the agent to perform tasks.</p>
      </div>
    ),
    location: 'workspace',
    target: '[data-tour-id="assistant-panel"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'workspace-focus',
    title: 'Element Focus Tool',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>The crosshair tool in the preview panel lets you select and focus on specific elements in your design.</p>
        <p>Click it to activate element selection mode, then click any element in the preview to highlight it.</p>
      </div>
    ),
    location: 'workspace',
    target: '[data-tour-id="focus-crosshair-button"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'workspace-checkpoint',
    title: 'Checkpoints & Manual Saves',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>"Discard Changes" reverts everything back to your last manual save in one click.</p>
        <p>The chevron next to it opens the Checkpoints panel, where you can browse and restore any earlier checkpoint — auto-saves are made after every AI task.</p>
        <p>If you like the result, use the Save button to lock it in as your manual checkpoint.</p>
      </div>
    ),
    location: 'workspace',
    target: '[data-tour-id="discard-changes-button"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'clear-conversation',
    title: 'Clear Conversation',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>The agent will have the last tasks and responses in memory. You can clear it with the trashcan button to start fresh.</p>
        <p>This removes the conversation history but keeps your project files intact.</p>
      </div>
    ),
    location: 'workspace',
    target: '[data-tour-id="clear-chat-button"]',
    showBack: true,
    primaryLabel: 'Next',
    secondaryLabel: 'Skip',
  },
  {
    id: 'provider-settings',
    title: 'Connect Your Provider',
    body: (
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>The quickest start is <strong>Sign in with OpenRouter</strong>, offered in an empty chat and under Settings › Connections. One click, no key to copy, and a capable model is picked for you.</p>
        <p>You can also paste a key from any supported provider, then choose models in the selector below. It stays one click away in the chat footer.</p>
        <p className="text-xs text-orange-500/90">
          Privacy note: Remote LLM providers (OpenAI, Anthropic, etc.) will receive your code when generating. Where local models are offered, Ollama or LM Studio keep everything on your machine.
        </p>
      </div>
    ),
    location: 'workspace',
    target: '[data-tour-id="provider-settings-trigger"]',
    showBack: true,
    primaryLabel: 'Finish',
    secondaryLabel: 'Skip',
  },
];
