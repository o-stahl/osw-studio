// lib/server-generate/sse-client.ts

type SSEEventHandler = (event: string, data: Record<string, unknown>) => void;

interface SSEClientOptions {
  onEvent: SSEEventHandler;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onSyncGap?: (projectId: string) => void;
}

export class SSEClient {
  private eventSource: EventSource | null = null;
  private lastEventId = '0';
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(private readonly options: SSEClientOptions) {}

  connect(): void {
    if (this.disposed) return;

    const url = new URL('/api/server-generate/events', window.location.origin);
    if (this.lastEventId !== '0') {
      url.searchParams.set('lastEventId', this.lastEventId);
    }
    this.eventSource = new EventSource(url.toString());

    this.eventSource.onopen = () => {
      this.options.onConnect?.();
    };

    this.eventSource.onerror = () => {
      this.eventSource?.close();
      this.eventSource = null;
      this.options.onDisconnect?.();
      if (!this.disposed) {
        this.reconnectTimer = setTimeout(() => this.connect(), 2000);
      }
    };

    const eventTypes = [
      // Chat panel rendering events
      'assistant_delta', 'reasoning_delta', 'reasoning_start', 'reasoning_complete',
      'toolCalls', 'tool_status', 'tool_param_delta', 'tool_result', 'tool_healed',
      'conversation_message', 'conversation_replaced', 'waiting', 'iteration', 'progress',
      'error', 'stopped', 'compaction', 'agent_progress', 'retry', 'api_stopped', 'model_switched', 'model_picked', 'model_resolved',
      'usage', 'skill_evaluation', 'checkpoint_created', 'exit_reason',
      // Server generation lifecycle
      'files_changed', 'build_requested', 'search_requested', 'image_requested', 'usage_update', 'approval_required',
      'task_complete', 'sync_gap', 'notification', 'runtimeChanged',
      // Requests from an MCP client, which this tab answers because it holds the provider key
      // and the local copy of the project.
      'mcp_run_requested', 'mcp_project_changed', 'mcp_deployment_changed',
    ];

    for (const eventType of eventTypes) {
      this.eventSource.addEventListener(eventType, (e: MessageEvent) => {
        if (e.lastEventId) {
          this.lastEventId = e.lastEventId;
        }
        try {
          const data = JSON.parse(e.data);
          if (eventType === 'sync_gap') {
            this.options.onSyncGap?.(data.sourceProjectId);
          } else {
            this.options.onEvent(eventType, data);
          }
        } catch {
          // Malformed event data — skip
        }
      });
    }
  }

  disconnect(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.eventSource?.close();
    this.eventSource = null;
  }

  isConnected(): boolean {
    return this.eventSource?.readyState === EventSource.OPEN;
  }
}
