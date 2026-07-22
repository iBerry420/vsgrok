import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import type { ChatMessage, ChatSession, TimelineSeg } from './types';

export type GrokSessionMeta = ChatSession & {
  cwd?: string;
  model?: string;
  status?: string;
  dir: string;
};

function grokHome(): string {
  return process.env.GROK_HOME || path.join(os.homedir(), '.grok');
}

function encodeWorkspaceKey(cwd: string): string {
  // Grok uses encodeURIComponent on the absolute path as the directory name
  return encodeURIComponent(path.resolve(cwd));
}

function sessionsRootForCwd(cwd: string): string {
  return path.join(grokHome(), 'sessions', encodeWorkspaceKey(cwd));
}

function readJsonSafe<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/**
 * List Grok Build sessions for a workspace cwd (from ~/.grok/sessions).
 */
export function listGrokSessions(cwd: string, limit = 80): GrokSessionMeta[] {
  const root = sessionsRootForCwd(cwd);
  if (!fs.existsSync(root)) return [];
  const out: GrokSessionMeta[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const summary = readJsonSafe<{
      info?: { id?: string; cwd?: string };
      session_summary?: string;
      generated_title?: string;
      created_at?: string;
      updated_at?: string;
      last_active_at?: string;
      num_chat_messages?: number;
      current_model_id?: string;
    }>(path.join(dir, 'summary.json'));
    const id = summary?.info?.id || name;
    const title =
      summary?.generated_title ||
      summary?.session_summary ||
      `Session ${id.slice(0, 8)}`;
    const createdAt = summary?.created_at ? Date.parse(summary.created_at) : 0;
    const updatedAt = summary?.last_active_at
      ? Date.parse(summary.last_active_at)
      : summary?.updated_at
        ? Date.parse(summary.updated_at)
        : createdAt;
    out.push({
      id,
      title,
      createdAt: createdAt || 0,
      updatedAt: updatedAt || 0,
      messageCount: summary?.num_chat_messages || 0,
      cwd: summary?.info?.cwd || cwd,
      model: summary?.current_model_id,
      dir,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out.slice(0, limit);
}

/** Also list recent sessions from other cwds via `grok sessions list` text (fallback). */
export function listGrokSessionsCli(limit = 40): GrokSessionMeta[] {
  try {
    const { execSync } = require('child_process') as typeof import('child_process');
    const grokBin = process.env.VSGROK_GROK_BIN || 'grok';
    const raw = execSync(`"${grokBin}" sessions list -n ${limit}`, {
      encoding: 'utf8',
      timeout: 8000,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const lines = raw.split('\n').slice(1); // skip header
    const out: GrokSessionMeta[] = [];
    for (const line of lines) {
      // SESSION ID ... STATUS ... SUMMARY
      const m = line.match(
        /^([0-9a-f-]{36})\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/i
      );
      if (!m) continue;
      const id = m[1];
      const summary = m[5].trim();
      out.push({
        id,
        title: summary || id.slice(0, 8),
        createdAt: 0,
        updatedAt: 0,
        messageCount: 0,
        status: m[4],
        dir: findSessionDir(id) || '',
      });
    }
    return out;
  } catch {
    return [];
  }
}

export function findSessionDir(sessionId: string): string | null {
  const root = path.join(grokHome(), 'sessions');
  if (!fs.existsSync(root)) return null;
  // Direct scan of workspace folders
  try {
    for (const ws of fs.readdirSync(root)) {
      const dir = path.join(root, ws, sessionId);
      if (fs.existsSync(path.join(dir, 'summary.json')) || fs.existsSync(path.join(dir, 'chat_history.jsonl'))) {
        return dir;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b && typeof b === 'object') {
          const o = b as { type?: string; text?: string; summary_text?: string };
          if (o.text) return o.text;
          if (o.summary_text) return o.summary_text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const o = content as { text?: string; content?: unknown };
    if (typeof o.text === 'string') return o.text;
    if (o.content != null) return extractText(o.content);
  }
  return '';
}

/** Grok Build stores thoughts as type=reasoning with summary[].text (not content). */
function extractReasoningText(row: {
  content?: unknown;
  summary?: unknown;
  text?: unknown;
}): string {
  if (Array.isArray(row.summary)) {
    const parts = row.summary
      .map((s) => {
        if (!s || typeof s !== 'object') return '';
        const o = s as { type?: string; text?: string };
        return o.text || '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('\n\n');
  }
  const fromContent = extractText(row.content);
  if (fromContent) return fromContent;
  if (typeof row.text === 'string') return row.text;
  return '';
}

/**
 * Reduce Grok-stored user turns to the human-visible message.
 *
 * Primary rule (bridge format): text after the last *line-start* `[User]:`.
 * Line-anchoring avoids false cuts when the user types `"[User]: "` mid-line.
 * Also drops pure meta rows (user_info, system-reminder, synthetic skills, etc.).
 */
export function displayUserText(raw: string): string {
  let t = String(raw || '').trim();
  if (!t) return '';

  // 1) Bridge / agent wrapper: everything after last line-start `[User]:`
  //    (must run on raw first so we don't lose the real marker).
  const lineMarks = [...t.matchAll(/(?:^|\n)\[User\]:\s*/gi)];
  if (lineMarks.length) {
    const last = lineMarks[lineMarks.length - 1];
    let out = t.slice(last.index! + last[0].length).trim();
    out = out.replace(/<\/user_query>\s*$/i, '').trim();
    // Drop accidental trailing meta tags
    out = out.replace(/<(system-reminder|user_info|additional_notes)\b[\s\S]*$/i, '').trim();
    if (out) return out;
  }

  // 2) Unwrap <user_query> (last closed block if several)
  const queries = [...t.matchAll(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/gi)];
  if (queries.length) {
    t = (queries[queries.length - 1][1] || '').trim();
  }

  // 3) Strip known meta / injection blocks (closed tags)
  const stripTags = [
    'user_info',
    'system-reminder',
    'additional_notes',
    'conversation_history',
    'agent_skills',
    'available_skills',
    'open_and_recently_viewed_files',
    'mcp_servers',
    'rules',
    'user_rules',
    'git_status',
    'environment_details',
    'attached_files',
  ];
  for (const tag of stripTags) {
    t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
  }
  // Unclosed meta payloads (entire remainder is system noise)
  t = t.replace(/<system-reminder\b[^>]*>[\s\S]*/gi, '');
  t = t.replace(/<user_info\b[^>]*>[\s\S]*/gi, '');
  t = t.replace(/<rules\b[^>]*>[\s\S]*/gi, '');
  t = t.replace(/<agent_skills\b[^>]*>[\s\S]*/gi, '');

  t = t.trim();
  if (!t) return '';

  // Retry [User]: after stripping (in case marker was nested oddly)
  const marks2 = [...t.matchAll(/(?:^|\n)\[User\]:\s*/gi)];
  if (marks2.length) {
    const last = marks2[marks2.length - 1];
    t = t.slice(last.index! + last[0].length).trim();
  } else {
    t = t
      .replace(
        /^When you reply, write only your new answer\.\s*Do not repeat prior lines unless asked\.\s*/i,
        ''
      )
      .trim();
  }

  if (!t) return '';
  const withoutTags = t.replace(/<[^>]+>/g, '').trim();
  if (!withoutTags) return '';
  if (
    /^(MCP servers|Do not attempt to use tools|The following skills are available)/i.test(
      withoutTags
    ) &&
    withoutTags.length < 800
  ) {
    return '';
  }
  if (/^<(user_info|system-reminder|rules|agent_skills)\b/i.test(t)) {
    return '';
  }

  return t.trim();
}

/**
 * Load displayable messages from Grok Build chat_history.jsonl.
 */
export function loadGrokMessages(sessionId: string, dir?: string): ChatMessage[] {
  const sessionDir = dir || findSessionDir(sessionId);
  if (!sessionDir) return [];
  const historyPath = path.join(sessionDir, 'chat_history.jsonl');
  if (!fs.existsSync(historyPath)) return [];

  const messages: ChatMessage[] = [];
  let openAssistant: ChatMessage | null = null;
  /** Grok writes reasoning *before* the following assistant turn — buffer it. */
  let pendingThinking: string[] = [];

  const lines = fs.readFileSync(historyPath, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let row: {
      type?: string;
      content?: unknown;
      summary?: unknown;
      text?: unknown;
      tool_calls?: { name?: string; arguments?: string }[];
      prompt_index?: number;
      synthetic_reason?: string;
    };
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const type = row.type || '';

    if (type === 'user') {
      openAssistant = null;
      pendingThinking = [];
      // Synthetic system rows (skills list, MCP status) are not human turns
      if (row.synthetic_reason) continue;
      const raw = extractText(row.content);
      const text = displayUserText(raw);
      if (!text) continue;
      const idx = messages.length;
      messages.push({
        id: stableMsgId(sessionId, idx, 'user', text),
        role: 'user',
        content: text,
        createdAt: Date.now(),
      });
      continue;
    }

    if (type === 'reasoning' || type === 'thought' || type === 'thinking') {
      const text = extractReasoningText(row);
      if (!text) continue;
      // Grok order is usually reasoning → assistant; buffer for the next turn.
      pendingThinking.push(text);
      continue;
    }

    if (type === 'assistant') {
      const text = extractText(row.content);
      const timeline: TimelineSeg[] = [];
      // Thoughts that arrived just before this assistant message
      if (pendingThinking.length) {
        for (const th of pendingThinking) {
          timeline.push({ type: 'thinking', content: th, done: true });
        }
        pendingThinking = [];
      }
      if (text) timeline.push({ type: 'text', content: text });
      if (Array.isArray(row.tool_calls)) {
        for (const tc of row.tool_calls) {
          let detail =
            typeof tc.arguments === 'string'
              ? tc.arguments
              : tc.arguments != null
                ? JSON.stringify(tc.arguments)
                : '';
          detail = prettifyJsonString(detail);
          timeline.push({
            type: 'tool',
            tool: tc.name || 'tool',
            detail,
            success: null,
            info: '',
          });
        }
      }
      const idx = messages.length;
      const thinkingJoined = timeline
        .filter((s) => s.type === 'thinking')
        .map((s) => (s as { content: string }).content)
        .join('\n\n');
      const msg: ChatMessage = {
        id: stableMsgId(sessionId, idx, 'assistant', text),
        role: 'assistant',
        content: text,
        createdAt: Date.now(),
        metadata: timeline.length
          ? { timeline, thinking: thinkingJoined || null }
          : undefined,
      };
      messages.push(msg);
      openAssistant = msg;
      continue;
    }

    if (type === 'tool_result' && openAssistant) {
      const text = extractText(row.content); // full result — no truncation
      const tl = openAssistant.metadata?.timeline
        ? [...openAssistant.metadata.timeline]
        : [];
      for (let i = tl.length - 1; i >= 0; i--) {
        const seg = tl[i];
        if (seg.type === 'tool' && seg.success == null) {
          seg.success = true;
          seg.info = prettifyJsonString(text || 'ok');
          break;
        }
      }
      openAssistant.metadata = { ...(openAssistant.metadata || {}), timeline: tl };
    }
  }

  // Orphan thinking at end (no following assistant yet)
  if (pendingThinking.length) {
    const text = pendingThinking.join('\n\n');
    const idx = messages.length;
    messages.push({
      id: stableMsgId(sessionId, idx, 'assistant', text),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      metadata: {
        thinking: text,
        timeline: [{ type: 'thinking', content: text, done: true }],
      },
    });
  }

  return messages;
}

export function newGrokSessionId(): string {
  // UUID v4-ish; Grok accepts valid UUIDs for --session-id
  return crypto.randomUUID();
}

export function sessionExists(sessionId: string): boolean {
  return !!findSessionDir(sessionId);
}

function stableMsgId(
  sessionId: string,
  index: number,
  role: string,
  content: string
): string {
  return crypto
    .createHash('sha1')
    .update(`${sessionId}:${index}:${role}:${content.slice(0, 200)}`)
    .digest('hex')
    .slice(0, 16);
}

/** Pretty-print JSON strings when possible (for tool args / results). */
export function prettifyJsonString(s: string): string {
  const t = String(s || '').trim();
  if (!t) return s;
  try {
    if (
      (t.startsWith('{') && t.endsWith('}')) ||
      (t.startsWith('[') && t.endsWith(']'))
    ) {
      return JSON.stringify(JSON.parse(t), null, 2);
    }
  } catch {
    /* not json */
  }
  return s;
}
