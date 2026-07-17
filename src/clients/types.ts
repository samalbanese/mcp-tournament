export interface ModelMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export interface ModelToolDefinition {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ModelContentBlock {
  [key: string]: unknown;
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

export interface ModelResponse {
  text: string;
  content: ModelContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
}

export interface CreateMessageParams {
  model: string;
  system?: string;
  messages: ModelMessage[];
  max_tokens: number;
  tools?: ModelToolDefinition[] | null;
}

/** Extension point for future model routes such as claude-agent-sdk. */
export interface ModelClient {
  createMessage(params: CreateMessageParams): Promise<ModelResponse>;
}
