/**
 * Provider-specific types and interfaces
 */

export type BuiltInProviderId =
  | 'openrouter'
  | 'openai'
  | 'openai-codex'
  | 'anthropic'
  | 'groq'
  | 'gemini'
  | 'huggingface'
  | 'ollama'
  | 'lmstudio'
  | 'sambanova'
  | 'deepseek'
  | 'zhipu'
  | 'minimax'
  | 'llamacpp'
  | 'meshllm'
  | 'opencode-go'
  | 'pollinations'
  | 'vercel';

/** Provider ID type. Includes built-in providers and arbitrary custom IDs. */
export type ProviderId = BuiltInProviderId | (string & {});

export type InputModality = 'text' | 'image' | 'audio' | 'file';

export type OutputModality = 'text' | 'image' | 'audio';

export interface ProviderModel {
  id: string;
  name: string;
  description?: string;
  contextLength: number;
  maxTokens?: number;
  supportsFunctions?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
  inputModalities?: InputModality[];
  outputModalities?: OutputModality[]; // default ['text'] when absent
  pricing?: {
    input: number;  // per 1M tokens
    output: number; // per 1M tokens
    reasoning?: number;
  };
  /** The provider lists it as free to use. Absent when the provider does not say. */
  free?: boolean;
  /** Live availability as the provider reports it (Pollinations). Absent when it reports none. */
  health?: 'healthy' | 'degraded' | 'down';
}

export interface ProviderConfig {
  id: ProviderId;
  name: string;
  description: string;
  apiKeyRequired: boolean;
  /**
   * The key's format, as a hint in the empty field (`sk-ant-...`, `hf_...`). Not prose: when a
   * provider has no distinctive format, leave this out and the UI shows its own translated label.
   */
  apiKeyPlaceholder?: string;
  apiKeyHelpUrl?: string;
  baseUrl?: string;
  customHeaders?: Record<string, string>;
  models?: ProviderModel[];
  supportsModelDiscovery?: boolean;
  supportsFunctions?: boolean;
  supportsStreaming?: boolean;
  isLocal?: boolean;
  usesOAuth?: boolean;
}

export interface CodexAuthData {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // Unix timestamp in seconds
  user_email?: string;
}

export interface HFAuthData {
  access_token: string;
  username?: string;
  expires_at?: number;  // OAuth tokens expire, API keys don't
  scopes?: string; // space-separated granted OAuth scopes
}
