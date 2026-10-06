/**
 * Single source of truth for telemetry events. The type union and the
 * disclosure dialog's "what will be collected" list both derive from this
 * catalog, so an event cannot be disclosed without existing or exist without
 * being disclosed.
 */

import type en from '@/messages/en.json';

/** A line of the disclosure dialog, as a key under `telemetry.lines` in the messages. */
type DisclosureLineKey = keyof typeof en.telemetry.lines;

export const DISCLOSURE_CATEGORIES = [
  { id: 'usage' },
  { id: 'generation' },
  { id: 'projects' },
  { id: 'features' },
] as const;

export type DisclosureCategoryId = (typeof DISCLOSURE_CATEGORIES)[number]['id'];

export interface TelemetryEventDef {
  /** Grouping for the disclosure dialog. */
  category: DisclosureCategoryId;
  /** The line the disclosure dialog shows for this event; several events can share one. */
  disclosure: DisclosureLineKey;
}

export const EVENT_CATALOG = {
  // usage
  session_start:      { category: 'usage', disclosure: 'sessionStart' },
  pageview:           { category: 'usage', disclosure: 'pageview' },
  heartbeat:          { category: 'usage', disclosure: 'heartbeat' },
  telemetry_accepted: { category: 'usage', disclosure: 'accepted' },
  telemetry_disabled: { category: 'usage', disclosure: 'disabled' },
  tour_started:       { category: 'usage', disclosure: 'tour' },
  tour_completed:     { category: 'usage', disclosure: 'tour' },
  tour_abandoned:     { category: 'usage', disclosure: 'tour' },

  // generation
  provider_selected:  { category: 'generation', disclosure: 'providerSelected' },
  model_selected:     { category: 'generation', disclosure: 'modelSelected' },
  task_started:       { category: 'generation', disclosure: 'taskStarted' },
  task_complete:      { category: 'generation', disclosure: 'taskComplete' },
  task_fail:          { category: 'generation', disclosure: 'taskFail' },
  task_nudged:        { category: 'generation', disclosure: 'nudged' },
  tool_call:          { category: 'generation', disclosure: 'toolCall' },
  api_error:          { category: 'generation', disclosure: 'apiError' },
  compaction_fired:   { category: 'generation', disclosure: 'compaction' },
  agent_spawned:      { category: 'generation', disclosure: 'agentSpawned' },
  skill_read:         { category: 'generation', disclosure: 'skillRead' },
  ask_response:       { category: 'generation', disclosure: 'askResponse' },
  approval_response:  { category: 'generation', disclosure: 'approvalResponse' },

  // projects
  project_create:     { category: 'projects', disclosure: 'projectCreate' },
  project_open:       { category: 'projects', disclosure: 'projectLifecycle' },
  project_delete:     { category: 'projects', disclosure: 'projectLifecycle' },
  project_export:     { category: 'projects', disclosure: 'projectLifecycle' },
  project_import:     { category: 'projects', disclosure: 'projectLifecycle' },
  runtime_switch:     { category: 'projects', disclosure: 'runtimeSwitch' },
  deployment_create:  { category: 'projects', disclosure: 'deployments' },
  deployment_publish: { category: 'projects', disclosure: 'deployments' },
  deployment_delete:  { category: 'projects', disclosure: 'deployments' },
  custom_domain_set:  { category: 'projects', disclosure: 'deployments' },
  backend_feature_enabled: { category: 'projects', disclosure: 'backendFeatures' },
  sync_manual:        { category: 'projects', disclosure: 'syncManual' },
  sync_fail:          { category: 'projects', disclosure: 'syncFail' },

  // features
  mode_switch:        { category: 'features', disclosure: 'modeSwitch' },
  quick_edit_opened:  { category: 'features', disclosure: 'quickEdit' },
  stop_reason_shown:  { category: 'generation', disclosure: 'stopReason' },
  stop_reason:        { category: 'generation', disclosure: 'stopReason' },
  interview_started:  { category: 'features', disclosure: 'interview' },
  interview_completed:{ category: 'features', disclosure: 'interview' },
  interview_abandoned:{ category: 'features', disclosure: 'interview' },
  handoff_used:       { category: 'features', disclosure: 'handoff' },
  skill_created:      { category: 'features', disclosure: 'customItems' },
  skill_deleted:      { category: 'features', disclosure: 'customItems' },
  interview_template_created: { category: 'features', disclosure: 'customItems' },
  interview_template_deleted: { category: 'features', disclosure: 'customItems' },
  model_template_created:     { category: 'features', disclosure: 'customItems' },
  model_template_deleted:     { category: 'features', disclosure: 'customItems' },
  preflight_result:   { category: 'features', disclosure: 'preflight' },
  connection_added:   { category: 'features', disclosure: 'connectionAdded' },
  connection_removed: { category: 'features', disclosure: 'connectionRemoved' },
  image_attached:     { category: 'features', disclosure: 'imageAttached' },
  voice_input_used:   { category: 'features', disclosure: 'voiceInput' },
  code_edited:        { category: 'features', disclosure: 'codeEdited' },
  checkpoint_restore: { category: 'features', disclosure: 'checkpoints' },
  changes_discarded:  { category: 'features', disclosure: 'checkpoints' },
} as const satisfies Record<string, TelemetryEventDef>;

export type TelemetryEventName = keyof typeof EVENT_CATALOG;

export type TelemetryEventProperties = Record<string, unknown>;

export interface TelemetryEvent {
  event: TelemetryEventName;
  timestamp: number;
  fields: Record<string, unknown>;
}

/** Deduplicated disclosure lines per category, in catalog order. */
export function getDisclosureLines(): { id: DisclosureCategoryId; lines: DisclosureLineKey[] }[] {
  return DISCLOSURE_CATEGORIES.map(cat => {
    const lines: DisclosureLineKey[] = [];
    for (const def of Object.values(EVENT_CATALOG)) {
      if (def.category === cat.id && !lines.includes(def.disclosure)) lines.push(def.disclosure);
    }
    return { id: cat.id, lines };
  }).filter(g => g.lines.length > 0);
}
