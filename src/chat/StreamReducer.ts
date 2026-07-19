import type { TimelineSeg } from './types';
import type { BridgeEvent } from '../bridge/BridgeClient';

export type StreamState = {
  streaming: boolean;
  model: string;
  startTime: number;
  fullText: string;
  thinkingSummary: string;
  toolCount: number;
  timeline: TimelineSeg[];
  messageId: number | null;
  error: string | null;
  done: boolean;
  duration: number;
  interrupted: boolean;
};

export function createStreamState(): StreamState {
  return {
    streaming: false,
    model: '',
    startTime: 0,
    fullText: '',
    thinkingSummary: '',
    toolCount: 0,
    timeline: [],
    messageId: null,
    error: null,
    done: false,
    duration: 0,
    interrupted: false,
  };
}

function sealOpenThinking(timeline: TimelineSeg[]): void {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const seg = timeline[i];
    if (seg.type === 'thinking') {
      seg.done = true;
      return;
    }
    if (seg.type === 'text' || seg.type === 'tool' || seg.type === 'media') return;
  }
}

function applyToolDone(
  timeline: TimelineSeg[],
  toolName: string,
  success: boolean,
  info: string,
  detail?: string
): void {
  let fallback = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const seg = timeline[i];
    if (seg.type !== 'tool' || seg.success != null) continue;
    if (toolName && seg.tool === toolName) {
      seg.success = success;
      if (info) seg.info = info;
      if (detail) seg.detail = detail;
      return;
    }
    if (fallback < 0) fallback = i;
  }
  if (fallback >= 0) {
    const seg = timeline[fallback] as Extract<TimelineSeg, { type: 'tool' }>;
    seg.success = success;
    if (info) seg.info = info;
    if (detail) seg.detail = detail;
    if (toolName) seg.tool = toolName;
  }
}

/**
 * Pure reducer for bridge stream events (parity with system-chat.js / bridge timeline).
 */
export function reduceStreamEvent(state: StreamState, evt: BridgeEvent): StreamState {
  const next: StreamState = {
    ...state,
    timeline: state.timeline.map((s) => ({ ...s })),
  };

  switch (evt.type) {
    case 'agent_resume':
      next.streaming = true;
      next.done = false;
      next.error = null;
      next.interrupted = false;
      if (evt.message_id) next.messageId = Number(evt.message_id) || next.messageId;
      // Replay will rebuild timeline — clear for clean replay
      next.timeline = [];
      next.fullText = '';
      next.thinkingSummary = '';
      next.toolCount = 0;
      if (!next.startTime) next.startTime = Date.now();
      break;

    case 'init':
      next.streaming = true;
      next.done = false;
      next.error = null;
      next.model = String(evt.model || next.model || '');
      if (!next.startTime) next.startTime = Date.now();
      break;

    case 'thinking_delta':
      if (evt.content) {
        const content = String(evt.content);
        next.thinkingSummary += content;
        const last = next.timeline[next.timeline.length - 1];
        if (last && last.type === 'thinking' && !last.done) {
          last.content += content;
        } else {
          sealOpenThinking(next.timeline);
          next.timeline.push({ type: 'thinking', content, done: false });
        }
      }
      break;

    case 'thinking_done':
      sealOpenThinking(next.timeline);
      break;

    case 'chunk':
      if (evt.content) {
        const content = String(evt.content);
        sealOpenThinking(next.timeline);
        next.fullText += content;
        const last = next.timeline[next.timeline.length - 1];
        if (last && last.type === 'text') {
          last.content += content;
        } else {
          next.timeline.push({ type: 'text', content });
        }
      }
      break;

    case 'text_replace':
      if (evt.content != null) {
        sealOpenThinking(next.timeline);
        while (next.timeline.length && next.timeline[next.timeline.length - 1].type === 'text') {
          next.timeline.pop();
        }
        const content = String(evt.content);
        next.fullText = content;
        next.timeline.push({ type: 'text', content });
      }
      break;

    case 'tool_start': {
      sealOpenThinking(next.timeline);
      next.toolCount += 1;
      next.timeline.push({
        type: 'tool',
        tool: String(evt.tool || 'tool'),
        detail: String(evt.detail || ''),
        success: null,
        info: '',
      });
      break;
    }

    case 'tool_done': {
      const toolName = String(evt.tool || '');
      const ok = evt.success !== false;
      const info = String(evt.info || '');
      applyToolDone(next.timeline, toolName, ok, info, evt.detail ? String(evt.detail) : undefined);
      break;
    }

    case 'media':
      if (evt.url) {
        sealOpenThinking(next.timeline);
        next.timeline.push({
          type: 'media',
          kind: String(evt.kind || 'image'),
          url: String(evt.url),
          name: String(evt.name || ''),
          tool: evt.tool ? String(evt.tool) : null,
        });
      }
      break;

    case 'partial_msg_id':
      if (evt.message_id) next.messageId = Number(evt.message_id) || next.messageId;
      break;

    case 'done':
      sealOpenThinking(next.timeline);
      for (const seg of next.timeline) {
        if (seg.type === 'tool' && seg.success == null) seg.success = true;
      }
      next.streaming = false;
      next.done = true;
      if (evt.content != null && String(evt.content).length >= next.fullText.length) {
        next.fullText = String(evt.content);
      }
      next.duration = Number(evt.duration) || Date.now() - (next.startTime || Date.now());
      if (evt.model) next.model = String(evt.model);
      break;

    case 'error':
      next.streaming = false;
      next.done = true;
      next.error = String(evt.content || 'unknown error');
      if (!next.fullText) next.fullText = `Error: ${next.error}`;
      next.timeline.push({ type: 'text', content: `Error: ${next.error}` });
      break;

    case 'interrupted':
      sealOpenThinking(next.timeline);
      next.streaming = false;
      next.done = true;
      next.interrupted = true;
      if (evt.content && String(evt.content).length > next.fullText.length) {
        next.fullText = String(evt.content);
      }
      next.duration = Number(evt.duration) || Date.now() - (next.startTime || Date.now());
      break;

    case 'no_agent':
      if (next.streaming) {
        next.streaming = false;
        next.done = true;
        next.interrupted = true;
      }
      break;

    case 'bridge_stopping':
      // keep streaming flag; client will reconnect
      break;

    default:
      break;
  }

  return next;
}

/** Build history content for a past assistant message (web parity). */
export function historyContentFromMessage(content: string, metadata?: ChatMessageMeta): string {
  if (metadata?.timeline && metadata.timeline.length) {
    const parts: string[] = [];
    for (const seg of metadata.timeline) {
      if (seg.type === 'thinking' && seg.content) {
        parts.push(`<thinking>\n${seg.content}\n</thinking>`);
      } else if (seg.type === 'tool') {
        parts.push(
          `[${seg.tool || ''}] ${seg.detail || ''} → ${seg.info || (seg.success ? 'ok' : '')}`
        );
      } else if (seg.type === 'text' && seg.content) {
        parts.push(seg.content);
      }
    }
    return parts.join('\n\n');
  }
  let out = content || '';
  if (metadata?.thinking) {
    out = `<thinking>\n${metadata.thinking}\n</thinking>\n\n${out}`;
  }
  return out;
}

type ChatMessageMeta = {
  timeline?: TimelineSeg[];
  thinking?: string | null;
  tools?: unknown;
  streaming?: boolean;
};

export function buildMetadataFromStream(state: StreamState, finalize: boolean) {
  const timeline = state.timeline.map((s) => {
    if (s.type === 'thinking') return { ...s, done: finalize ? true : s.done };
    if (s.type === 'tool' && finalize && s.success == null) return { ...s, success: true };
    return { ...s };
  });
  return {
    model: state.model || null,
    duration: state.duration || (state.startTime ? Date.now() - state.startTime : null),
    tool_count: state.toolCount,
    thinking: state.thinkingSummary || null,
    timeline,
    streaming: !finalize,
    interrupted: state.interrupted || undefined,
    error: !!state.error || undefined,
  };
}
