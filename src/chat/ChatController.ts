import * as vscode from 'vscode';
import { BridgeClient, type BridgeEvent, type HistoryMessage } from '../bridge/BridgeClient';
import { BridgeManager } from '../bridge/BridgeManager';
import {
  buildMetadataFromStream,
  createStreamState,
  historyContentFromMessage,
  reduceStreamEvent,
  type StreamState,
} from './StreamReducer';
import { newMessageId, SessionStore } from './SessionStore';
import {
  listGrokSessions,
  loadGrokMessages,
  newGrokSessionId,
  sessionExists,
  type GrokSessionMeta,
} from './GrokSessions';
import { packContext } from '../context/ContextPacker';
import { ApplyService, extractFileEdits } from '../apply/ApplyService';
import type { ChatMessage, ChatNote } from './types';

export type UiMessage =
  | { type: 'ready' }
  | { type: 'state'; payload: Record<string, unknown> }
  | { type: 'stream'; payload: StreamState }
  | { type: 'toast'; level: 'info' | 'error' | 'warn'; text: string };

export class ChatController {
  private client = new BridgeClient();
  private stream = createStreamState();
  private streamingMsgId: string | null = null;
  private pinnedPaths: string[] = [];
  private pinnedSelection: string | null = null;
  private post: (msg: UiMessage) => void = () => {};
  /** In-memory messages for the active Grok session (loaded from disk + live). */
  private liveMessages: ChatMessage[] = [];
  private usageCache: Record<string, unknown> | null = null;

  constructor(
    private readonly store: SessionStore,
    private readonly bridge: BridgeManager,
    private readonly applyService: ApplyService,
    private readonly output: vscode.OutputChannel
  ) {
    this.client.on('event', (evt: BridgeEvent) => this.onBridgeEvent(evt));
    this.client.on('state', (connected: boolean, detail: string | null) => {
      this.pushState({ bridgeConnected: connected, bridgeDetail: detail });
    });
  }

  setPoster(fn: (msg: UiMessage) => void): void {
    this.post = fn;
  }

  private workspaceCwd(): string {
    return (
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      require('os').homedir()
    );
  }

  async ensureSession(): Promise<string> {
    let id = this.store.getActiveSessionId();
    if (id) {
      this.reloadMessages(id);
      return id;
    }
    // Prefer most recent Grok session for this workspace
    const sessions = listGrokSessions(this.workspaceCwd(), 1);
    if (sessions[0]) {
      id = sessions[0].id;
      await this.store.setActiveSessionId(id);
      this.reloadMessages(id);
      return id;
    }
    id = newGrokSessionId();
    await this.store.setActiveSessionId(id);
    this.liveMessages = [];
    return id;
  }

  private reloadMessages(sessionId: string): void {
    this.liveMessages = loadGrokMessages(sessionId);
  }

  private listSessions(): GrokSessionMeta[] {
    return listGrokSessions(this.workspaceCwd(), 100);
  }

  async connectClient(): Promise<void> {
    if (!this.bridge.isRunning) {
      await this.bridge.start();
    }
    await this.bridge.ensureSecret();
    const token = this.bridge.mintToken();
    if (!this.bridge.wsBase) {
      throw new Error('Bridge has no port after start');
    }
    this.client.connect(this.bridge.wsBase, token);
  }

  /** Start bridge + WS if needed (idempotent, silent). */
  async ensureBridge(): Promise<void> {
    if (!this.bridge.isRunning) {
      await this.bridge.start();
    }
    if (!this.client.connected) {
      await this.connectClient();
      // brief wait for open
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  disconnectClient(): void {
    this.client.disconnect();
  }

  async fullState(): Promise<Record<string, unknown>> {
    const sessionId = await this.ensureSession();
    const sessions = this.listSessions();
    // Ensure active session appears even if brand-new (not yet on disk)
    const sessionList = sessions.some((s) => s.id === sessionId)
      ? sessions
      : [
          {
            id: sessionId,
            title: 'New Chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messageCount: this.liveMessages.length,
            dir: '',
          },
          ...sessions,
        ];
    const active = sessionList.find((s) => s.id === sessionId);
    const notes = this.store.getNotes();
    const cfg = vscode.workspace.getConfiguration('vsgrok');
    let models: { id: string; name: string }[] = [];
    let defaultModel = cfg.get<string>('defaultModel', 'gb:grok-4.5');
    let health: unknown = null;
    try {
      const m = await this.bridge.models();
      if (m?.grok_models?.length) {
        models = m.grok_models.map((x) => ({
          id: x.id.startsWith('gb:') ? x.id : `gb:${x.id}`,
          name: x.name || x.id,
        }));
        defaultModel = m.default_model || defaultModel;
      }
      health = await this.bridge.health();
      if (!this.usageCache) {
        this.usageCache = await this.bridge.usage(false);
      }
    } catch {
      /* bridge down */
    }
    if (!models.length) {
      models = [
        { id: 'gb:grok-4.5', name: 'grok-4.5' },
        { id: 'gb:grok-composer-2.5-fast', name: 'grok-composer-2.5-fast' },
      ];
    }
    return {
      sessionId,
      sessionTitle: active?.title || 'New Chat',
      sessions: sessionList,
      messages: this.liveMessages,
      notes,
      models,
      defaultModel,
      selectedModel: cfg.get<string>('defaultModel', defaultModel),
      bridgeConnected: this.client.connected,
      bridgeRunning: this.bridge.isRunning,
      health,
      usage: this.usageCache,
      showThinking: cfg.get('showThinking', true),
      showTools: cfg.get('showTools', true),
      enterToSend: cfg.get('enterToSend', false),
      useHistory: cfg.get('useHistory', true),
      streaming: this.stream.streaming,
      stream: this.stream.streaming ? this.stream : null,
      pinnedPaths: this.pinnedPaths,
      workspace: this.workspaceCwd(),
    };
  }

  async pushFullState(): Promise<void> {
    this.post({ type: 'state', payload: await this.fullState() });
  }

  private pushState(partial: Record<string, unknown>): void {
    void this.fullState().then((s) => {
      this.post({ type: 'state', payload: { ...s, ...partial } });
    });
  }

  private onBridgeEvent(evt: BridgeEvent): void {
    this.stream = reduceStreamEvent(this.stream, evt);
    this.post({ type: 'stream', payload: this.stream });

    if (evt.type === 'done' || evt.type === 'error' || evt.type === 'interrupted') {
      void this.finalizeStream();
    }
  }

  private async finalizeStream(): Promise<void> {
    const sessionId = this.store.getActiveSessionId();
    if (!sessionId || !this.streamingMsgId) {
      this.client.setStreamingSession(null);
      return;
    }
    const meta = buildMetadataFromStream(this.stream, true);
    const content =
      this.stream.fullText || (this.stream.error ? `Error: ${this.stream.error}` : '');
    const idx = this.liveMessages.findIndex((m) => m.id === this.streamingMsgId);
    if (idx >= 0) {
      this.liveMessages[idx] = {
        ...this.liveMessages[idx],
        content,
        metadata: meta,
      };
    }
    this.applyService.remember(extractFileEdits(content));
    this.streamingMsgId = null;
    this.client.setStreamingSession(null);
    this.stream = createStreamState();
    // Grok CLI writes chat_history — reload shortly after for full transcript
    setTimeout(() => {
      this.reloadMessages(sessionId);
      void this.pushFullState();
      void this.refreshUsage(false);
    }, 800);
    await this.pushFullState();
  }

  async send(text: string, model?: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.stream.streaming) {
      this.post({ type: 'toast', level: 'warn', text: 'Already streaming' });
      return;
    }

    try {
      await this.ensureBridge();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'toast', level: 'error', text: 'Bridge: ' + msg });
      this.output.appendLine(`[send] bridge ensure failed: ${msg}`);
      return;
    }

    const sessionId = await this.ensureSession();
    const resume = sessionExists(sessionId);
    const cfg = vscode.workspace.getConfiguration('vsgrok');
    const useHistory = cfg.get<boolean>('useHistory', true);
    const maxCtx = cfg.get<number>('maxContextBytes', 80000);
    const includeSelection = cfg.get<boolean>('includeSelection', true);

    const userMsg: ChatMessage = {
      id: newMessageId(),
      role: 'user',
      content: prompt,
      createdAt: Date.now(),
    };
    this.liveMessages.push(userMsg);

    const assistantId = newMessageId();
    this.streamingMsgId = assistantId;
    this.liveMessages.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      metadata: { streaming: true },
    });

    this.stream = createStreamState();
    this.stream.streaming = true;
    this.stream.startTime = Date.now();
    this.client.setStreamingSession(sessionId);

    // Push UI immediately so the user bubble + stream shell appear before
    // context packing / network (which can take hundreds of ms).
    await this.pushFullState();
    this.post({ type: 'stream', payload: this.stream });

    const packed = await packContext(prompt, {
      includeSelection,
      maxBytes: maxCtx,
      pinnedPaths: this.pinnedPaths,
      pinnedSelection: this.pinnedSelection,
    });
    this.pinnedSelection = null;

    const noteTexts = [
      ...this.store.getNotes().filter((n) => n.enabled).map((n) => n.text),
      ...packed.notes,
    ];

    // When resuming Grok session, Grok already has history — only send extra notes.
    // When new session, optionally include our local live history.
    let history: HistoryMessage[] | undefined;
    if (!resume && useHistory) {
      history = this.liveMessages
        .filter((m) => m.id !== assistantId && m.id !== userMsg.id)
        .filter((m) => !m.excludedFromContext)
        .filter((m) => !(m.role === 'assistant' && m.metadata?.streaming))
        .slice(-30)
        .map((m) => ({
          role: m.role,
          content:
            m.role === 'assistant'
              ? historyContentFromMessage(m.content, m.metadata)
              : m.content,
        }));
    }

    const selectedModel =
      model || cfg.get<string>('defaultModel', 'gb:grok-4.5') || 'gb:grok-4.5';

    const ok = this.client.sendPrompt({
      prompt,
      session_id: sessionId,
      model: selectedModel,
      history: history && history.length ? history : undefined,
      notes: noteTexts.length ? noteTexts : undefined,
      resume,
    });

    if (!ok) {
      this.stream = reduceStreamEvent(this.stream, {
        type: 'error',
        content: 'WebSocket not connected. Is the bridge running?',
      });
      await this.finalizeStream();
      return;
    }
  }

  async stopGeneration(): Promise<void> {
    const sessionId = this.store.getActiveSessionId();
    if (!sessionId || !this.stream.streaming) {
      this.post({ type: 'toast', level: 'info', text: 'Nothing to stop' });
      return;
    }
    const ok = this.client.stop(sessionId);
    if (!ok) {
      this.post({ type: 'toast', level: 'error', text: 'Could not send stop (WS down)' });
      return;
    }
    // Local finalize if bridge doesn't reply quickly
    this.stream = reduceStreamEvent(this.stream, {
      type: 'interrupted',
      content: this.stream.fullText,
      reason: 'user_stop',
    });
    await this.finalizeStream();
    this.post({ type: 'toast', level: 'info', text: 'Stopped' });
  }

  async toggleExcludeMessage(messageId: string, excluded?: boolean): Promise<void> {
    const m = this.liveMessages.find((x) => x.id === messageId);
    if (!m) return;
    m.excludedFromContext =
      excluded !== undefined ? excluded : !m.excludedFromContext;
    await this.pushFullState();
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.liveMessages = this.liveMessages.filter((m) => m.id !== messageId);
    await this.pushFullState();
  }

  async newSession(): Promise<void> {
    const id = newGrokSessionId();
    await this.store.setActiveSessionId(id);
    this.liveMessages = [];
    await this.pushFullState();
  }

  async switchSession(id: string): Promise<void> {
    await this.store.setActiveSessionId(id);
    this.reloadMessages(id);
    await this.pushFullState();
  }

  async deleteSession(id: string): Promise<void> {
    // Prefer grok CLI delete when available
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      const grokBin = vscode.workspace.getConfiguration('vsgrok').get('grokBin', 'grok');
      execSync(`"${grokBin}" sessions delete ${id}`, {
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      this.output.appendLine(`[sessions] delete failed: ${err}`);
      this.post({
        type: 'toast',
        level: 'warn',
        text: 'Could not delete via grok CLI — remove the session folder manually if needed.',
      });
    }
    if (this.store.getActiveSessionId() === id) {
      const next = this.listSessions().find((s) => s.id !== id);
      if (next) {
        await this.store.setActiveSessionId(next.id);
        this.reloadMessages(next.id);
      } else {
        await this.newSession();
        return;
      }
    }
    await this.pushFullState();
  }

  async renameSession(_id: string, _title: string): Promise<void> {
    // Grok owns titles (generated_title) — not freely renamable; no-op with toast
    this.post({
      type: 'toast',
      level: 'info',
      text: 'Grok Build sessions use auto titles from the conversation.',
    });
  }

  pinPath(p: string): void {
    if (!this.pinnedPaths.includes(p)) this.pinnedPaths.push(p);
    void this.pushFullState();
  }

  pinSelection(text: string): void {
    this.pinnedSelection = text;
    void this.pushFullState();
  }

  async saveNotes(notes: ChatNote[]): Promise<void> {
    this.store.saveNotes(notes);
    await this.pushFullState();
  }

  async setModel(model: string): Promise<void> {
    await vscode.workspace
      .getConfiguration('vsgrok')
      .update('defaultModel', model, vscode.ConfigurationTarget.Global);
    await this.pushFullState();
  }

  async setSetting(key: string, value: boolean): Promise<void> {
    const map: Record<string, string> = {
      showThinking: 'showThinking',
      showTools: 'showTools',
      enterToSend: 'enterToSend',
      useHistory: 'useHistory',
      includeSelection: 'includeSelection',
    };
    const cfgKey = map[key];
    if (!cfgKey) return;
    await vscode.workspace
      .getConfiguration('vsgrok')
      .update(cfgKey, value, vscode.ConfigurationTarget.Global);
    await this.pushFullState();
  }

  async refreshUsage(force = true): Promise<void> {
    try {
      if (!this.bridge.isRunning) await this.bridge.start();
      this.usageCache = await this.bridge.usage(force);
    } catch {
      this.usageCache = { ok: false, message: 'usage unavailable' };
    }
    await this.pushFullState();
  }

  async loginGrok(): Promise<void> {
    if (!this.bridge.isRunning) await this.bridge.start();
    const start = await this.bridge.startGrokLogin(true);
    const login = (start as { verification_uri_complete?: string; user_code?: string }) || {};
    const url = login.verification_uri_complete;
    if (url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
      void vscode.window.showInformationMessage(
        `VSGrok: complete Grok login in browser${login.user_code ? ` (code ${login.user_code})` : ''}.`
      );
    } else {
      void vscode.window.showWarningMessage(
        'Could not start device login. Try: grok login --device-code'
      );
    }
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const st = await this.bridge.grokLoginStatus();
      const status = (st as { status?: string })?.status;
      if (status === 'complete') {
        void vscode.window.showInformationMessage('VSGrok: Grok login complete.');
        await this.refreshUsage(true);
        return;
      }
      if (status === 'denied' || status === 'error') {
        void vscode.window.showErrorMessage('VSGrok: Grok login failed or denied.');
        return;
      }
    }
  }

  dispose(): void {
    this.client.disconnect();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
