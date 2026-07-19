import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ChatMessage, ChatNote, ChatSession } from './types';

type SessionFile = {
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
    fs.writeFileSync(this.indexPath, JSON.stringify(sessions, null, 2));
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
    const index = this.readIndex();
    index.unshift({
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    });
    this.writeIndex(index);
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
    fs.writeFileSync(this.sessionPath(session.id), JSON.stringify(session, null, 2));
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
    const session = this.loadSession(sessionId);
    if (!session) return null;
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
    fs.writeFileSync(this.notesPath, JSON.stringify(notes, null, 2));
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
