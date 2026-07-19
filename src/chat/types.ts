export type TimelineSeg =
  | { type: 'thinking'; content: string; done?: boolean }
  | { type: 'text'; content: string }
  | {
      type: 'tool';
      tool: string;
      detail?: string;
      success?: boolean | null;
      info?: string;
    }
  | { type: 'media'; kind: string; url: string; name?: string; tool?: string | null };

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  excludedFromContext?: boolean;
  metadata?: {
    model?: string | null;
    duration?: number | null;
    tool_count?: number;
    tools?: unknown;
    thinking?: string | null;
    timeline?: TimelineSeg[];
    media?: unknown[];
    streaming?: boolean;
    interrupted?: boolean;
    error?: boolean;
  };
};

export type ChatSession = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
};

export type ChatNote = {
  id: string;
  text: string;
  enabled: boolean;
};
