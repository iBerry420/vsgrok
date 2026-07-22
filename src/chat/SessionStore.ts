import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ChatMessage, ChatNote, ChatSession } from './types';

export type SessionFile = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

export class SessionStore {
  private root: string;
  private notesPath: string;
  private indexPath: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    const base =
      context.storageUri?.fsPath ||
      path.join(context.globalStorageUri.fsPath, 'workspace-default');
    this.root = path.join(base, 'sessions');
    this.notesPath = path.join(base, 'notes.json');
    this.indexPath = path.join(base, 'index.json');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private sessionPath(id: string): string {
    return path.join(this.root, `${id}.json`);
  }

  private readIndex(): ChatSession[] {
    try {
      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  private writeIndex(sessions: ChatSession[]): void {
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    atomicWriteJson(this.indexPath, sessions);
  }

  listSessions(): ChatSession[] {
    return this.readIndex().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getActiveSessionId(): string | undefined {
    return this.context.workspaceState.get<string>('vsgrok.activeSessionId');
  }

  async setActiveSessionId(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update('vsgrok.activeSessionId', id);
  }

  createSession(title = 'New Chat'): SessionFile {
    const id = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const session: SessionFile = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.writeSession(session);
    return session;
  }

  /**
   * Ensure a local mirror file exists for a Grok session id (UUID).
   * Used so we can persist transcript even before Grok writes chat_history.
   */
  ensureMirror(id: string, title = 'New Chat'): SessionFile {
    const existing = this.loadSession(id);
    if (existing) return existing;
    const now = Date.now();
    const session: SessionFile = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.writeSession(session);
    return session;
  }

  loadSession(id: string): SessionFile | null {
    try {
      const raw = fs.readFileSync(this.sessionPath(id), 'utf8');
      return JSON.parse(raw) as SessionFile;
    } catch {
      return null;
    }
  }

  writeSession(session: SessionFile): void {
    fs.mkdirSync(this.root, { recursive: true });
    atomicWriteJson(this.sessionPath(session.id), session);
    const index = this.readIndex();
    const row: ChatSession = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length,
    };
    const i = index.findIndex((s) => s.id === session.id);
    if (i >= 0) index[i] = row;
    else index.unshift(row);
    this.writeIndex(index);
  }

  /**
   * Persist full transcript for a session (durable across IDE reload / bridge death).
   */
  saveMessages(sessionId: string, messages: ChatMessage[], titleHint?: string): void {
    if (!sessionId) return;
    const prev = this.loadSession(sessionId);
    const now = Date.now();
    let title = prev?.title || 'New Chat';
    if (titleHint && titleHint.trim()) title = titleHint.slice(0, 255);
    else if (title === 'New Chat') {
      const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
      if (firstUser) title = autoTitle(firstUser.content);
    }
    this.writeSession({
      id: sessionId,
      title,
      createdAt: prev?.createdAt || now,
      updatedAt: now,
      messages: messages.map((m) => ({ ...m, metadata: m.metadata ? { ...m.metadata } : undefined })),
    });
  }

  renameSession(id: string, title: string): void {
    const session = this.loadSession(id);
    if (!session) return;
    session.title = title.slice(0, 255) || 'New Chat';
    session.updatedAt = Date.now();
    this.writeSession(session);
  }

  deleteSession(id: string): void {
    try {
      fs.unlinkSync(this.sessionPath(id));
    } catch {
      /* ignore */
    }
    this.writeIndex(this.readIndex().filter((s) => s.id !== id));
  }

  appendMessage(sessionId: string, message: ChatMessage): SessionFile | null {
    const session = this.ensureMirror(sessionId);
    session.messages.push(message);
    session.updatedAt = Date.now();
    if (
      session.title === 'New Chat' &&
      message.role === 'user' &&
      message.content.trim()
    ) {
      session.title = autoTitle(message.content);
    }
    this.writeSession(session);
    return session;
  }

  updateMessage(sessionId: string, messageId: string, patch: Partial<ChatMessage>): void {
    const session = this.loadSession(sessionId);
    if (!session) return;
    const m = session.messages.find((x) => x.id === messageId);
    if (!m) return;
    Object.assign(m, patch);
    session.updatedAt = Date.now();
    this.writeSession(session);
  }

  getNotes(): ChatNote[] {
    try {
      const raw = fs.readFileSync(this.notesPath, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  saveNotes(notes: ChatNote[]): void {
    fs.mkdirSync(path.dirname(this.notesPath), { recursive: true });
    atomicWriteJson(this.notesPath, notes);
  }
}

/** Atomic-ish JSON write so crashes mid-write don't wipe the prior file. */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(data, null, 2);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    fs.renameSync(tmp, filePath);
  } catch {
    // Windows / cross-device fallback
    fs.writeFileSync(filePath, body, 'utf8');
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

function autoTitle(content: string, maxLen = 48): string {
  let text = content.replace(/\s+/g, ' ').trim();
  if (!text) return 'New Chat';
  const m = text.match(/^(.{1,48}?)(?:[.!?](?:\s|$)|$)/);
  if (m) text = m[1].trim() || text;
  if (text.length > maxLen) text = text.slice(0, maxLen - 1).trimEnd() + '…';
  return text;
}

export function newMessageId(): string {
  return crypto.randomBytes(8).toString('hex');
}
