import * as vscode from 'vscode';
import { BridgeClient, type BridgeEvent, type HistoryMessage } from '../bridge/BridgeClient';
import { BridgeManager } from '../bridge/BridgeManager';
import {
  buildMetadataFromStream,
  createStreamState,
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
import { mergeTranscripts } from './mergeTranscripts';
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
  /** Active Grok session id for the current stream (for event filtering). */
  private streamSessionId: string | null = null;
  /**
   * Monotonic epoch so late events from a previous turn (or reconnect races)
   * cannot pollute the current stream bubble.
   */
  private streamEpoch = 0;
  private activeStreamEpoch = 0;
  /** Only apply bridge events after prompt is accepted / mid-stream resume. */
  private streamAcceptEvents = false;
  private pinnedPaths: string[] = [];
  private pinnedSelection: string | null = null;
  private post: (msg: UiMessage) => void = () => {};
  /** In-memory messages for the active Grok session (Grok disk + local mirror + live). */
  private liveMessages: ChatMessage[] = [];
  private usageCache: Record<string, unknown> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistAt = 0;

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
      // Load once when empty. Never reload while streaming or we already hold
      // in-memory turns (would wipe the just-sent user bubble).
      if (
        !this.liveMessages.length &&
        !this.stream.streaming &&
        !this.streamingMsgId
      ) {
        this.reloadMessages(id);
      }
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
    this.store.ensureMirror(id);
    this.liveMessages = [];
    return id;
  }

  /**
   * Load messages from Grok chat_history and merge with the local durable mirror
   * so recent turns survive IDE reload before Grok flushes disk.
   */
  private reloadMessages(sessionId: string): void {
    const fromGrok = loadGrokMessages(sessionId);
    const local = this.store.loadSession(sessionId)?.messages || [];
    this.liveMessages = mergeTranscripts(fromGrok, local);
  }

  /** Write live transcript to extension storage (survives reload / bridge death). */
  private persistLive(sessionId: string | null | undefined, force = false): void {
    if (!sessionId) return;
    const now = Date.now();
    if (!force && now - this.lastPersistAt < 400) {
      // coalesce rapid stream updates
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => {
        this.persistTimer = null;
        this.persistLive(sessionId, true);
      }, 450);
      return;
    }
    this.lastPersistAt = now;
    try {
      this.store.saveMessages(sessionId, this.liveMessages);
    } catch (err) {
      this.output.appendLine(`[persist] failed: ${err}`);
    }
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
            title: this.store.loadSession(sessionId)?.title || 'New Chat',
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
      sessionTitle: active?.title || this.store.loadSession(sessionId)?.title || 'New Chat',
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
      reasoningEffort: normalizeReasoningEffort(cfg.get('reasoningEffort', 'high')),
      streaming: this.stream.streaming,
      stream: this.stream.streaming ? this.stream : null,
      pinnedPaths: this.pinnedPaths,
      workspace: this.workspaceCwd(),
    };
  }

  async pushFullState(): Promise<void> {
    this.post({ type: 'state', payload: await this.fullState() });
  }

  /**
   * Instant transcript + stream shell (no bridge HTTP). Used so the user bubble
   * paints before models/health/network work in fullState.
   */
  private pushTranscriptState(extra: Record<string, unknown> = {}): void {
    this.post({
      type: 'state',
      payload: {
        sessionId: this.store.getActiveSessionId(),
        messages: this.liveMessages,
        streaming: this.stream.streaming,
        stream: this.stream.streaming ? this.stream : null,
        ...extra,
      },
    });
  }

  private pushState(partial: Record<string, unknown>): void {
    void this.fullState().then((s) => {
      this.post({ type: 'state', payload: { ...s, ...partial } });
    });
  }

  private onBridgeEvent(evt: BridgeEvent): void {
    // Drop events that belong to another session or a previous turn.
    if (!this.shouldAcceptBridgeEvent(evt)) {
      return;
    }

    const epoch = this.activeStreamEpoch;
    this.stream = reduceStreamEvent(this.stream, evt);

    // no_agent right after a fresh send (before init) must not kill the turn —
    // reconnect races fire this when streamingSessionId is set but agent not ready.
    if (evt.type === 'no_agent' && !this.stream.timeline.length && !this.stream.fullText) {
      // Keep streaming UI; wait for real agent events or a later error.
      this.stream = {
        ...this.stream,
        streaming: true,
        done: false,
        interrupted: false,
      };
      return;
    }

    this.post({ type: 'stream', payload: this.stream });

    // Throttled mirror of partial assistant content so reloads keep the stream.
    if (this.streamingMsgId && this.streamSessionId && this.stream.streaming) {
      this.snapshotStreamingMessage();
      this.persistLive(this.streamSessionId, false);
    }

    if (evt.type === 'done' || evt.type === 'error' || evt.type === 'interrupted') {
      // Ignore terminal events from a superseded epoch
      if (epoch !== this.activeStreamEpoch) return;
      void this.finalizeStream();
    }
  }

  private shouldAcceptBridgeEvent(evt: BridgeEvent): boolean {
    if (!this.streamingMsgId || !this.streamAcceptEvents) return false;
    if (this.activeStreamEpoch !== this.streamEpoch) return false;

    const sid = evt.session_id != null ? String(evt.session_id) : '';
    if (sid && this.streamSessionId) {
      // Bridge often shortens session_id in logs; accept prefix/suffix matches
      const want = this.streamSessionId;
      if (sid !== want && !want.startsWith(sid) && !sid.startsWith(want)) {
        return false;
      }
    }
    return true;
  }

  /** Push current stream snapshot into the in-memory assistant shell. */
  private snapshotStreamingMessage(): void {
    if (!this.streamingMsgId) return;
    const idx = this.liveMessages.findIndex((m) => m.id === this.streamingMsgId);
    if (idx < 0) return;
    const meta = buildMetadataFromStream(this.stream, false);
    this.liveMessages[idx] = {
      ...this.liveMessages[idx],
      content: this.stream.fullText || this.liveMessages[idx].content,
      metadata: meta,
    };
  }

  private beginStreamEpoch(sessionId: string, assistantId: string): void {
    this.streamEpoch += 1;
    this.activeStreamEpoch = this.streamEpoch;
    this.streamSessionId = sessionId;
    this.streamingMsgId = assistantId;
    this.streamAcceptEvents = false;
    this.stream = createStreamState();
    this.stream.streaming = true;
    this.stream.startTime = Date.now();
    // Do NOT setStreamingSession until prompt is on the wire — otherwise WS
    // open reconnect races fire no_agent / stale agent_resume into this turn.
    this.client.setStreamingSession(null);
  }

  private endStreamEpoch(): void {
    this.streamAcceptEvents = false;
    this.streamingMsgId = null;
    this.streamSessionId = null;
    this.client.setStreamingSession(null);
    this.stream = createStreamState();
  }

  private async finalizeStream(): Promise<void> {
    const sessionId = this.streamSessionId || this.store.getActiveSessionId();
    const msgId = this.streamingMsgId;
    if (!sessionId || !msgId) {
      this.endStreamEpoch();
      return;
    }
    const meta = buildMetadataFromStream(this.stream, true);
    const content =
      this.stream.fullText || (this.stream.error ? `Error: ${this.stream.error}` : '');
    const idx = this.liveMessages.findIndex((m) => m.id === msgId);
    if (idx >= 0) {
      this.liveMessages[idx] = {
        ...this.liveMessages[idx],
        content,
        metadata: meta,
      };
    }
    this.applyService.remember(extractFileEdits(content));

    // Durable save immediately (before Grok chat_history is available)
    this.persistLive(sessionId, true);
    this.endStreamEpoch();

    await this.pushFullState();

    // Grok CLI writes chat_history — reload and re-merge shortly after
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      // Don't clobber a newer in-flight turn
      if (this.stream.streaming) return;
      this.reloadMessages(sessionId);
      this.persistLive(sessionId, true);
      void this.pushFullState();
      void this.refreshUsage(false);
    }, 900);
  }

  async send(text: string, model?: string): Promise<void> {
    const prompt = text.trim();
    if (!prompt) return;
    if (this.stream.streaming) {
      this.post({ type: 'toast', level: 'warn', text: 'Already streaming' });
      return;
    }

    // Resolve session without reloading from disk (reload would race with in-memory
    // messages and delay the user bubble). Only load if we have no local copy yet.
    let sessionId = this.store.getActiveSessionId();
    if (!sessionId) {
      sessionId = await this.ensureSession();
    } else if (!this.liveMessages.length) {
      this.reloadMessages(sessionId);
    }
    this.store.ensureMirror(sessionId);

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
    const assistantId = newMessageId();
    this.liveMessages.push(userMsg);
    this.liveMessages.push({
      id: assistantId,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      metadata: { streaming: true },
    });

    this.beginStreamEpoch(sessionId, assistantId);

    // Persist user + shell immediately so reload mid-send keeps the turn
    this.persistLive(sessionId, true);

    // Paint user bubble + empty stream shell *synchronously* — never wait on
    // bridge HTTP (models/health) or ensureBridge before the UI updates.
    this.pushTranscriptState();
    this.post({ type: 'stream', payload: this.stream });
    // Full chrome (models, usage, sessions) in the background
    void this.pushFullState();

    try {
      await this.ensureBridge();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'toast', level: 'error', text: 'Bridge: ' + msg });
      this.output.appendLine(`[send] bridge ensure failed: ${msg}`);
      this.streamAcceptEvents = true;
      this.stream = reduceStreamEvent(this.stream, {
        type: 'error',
        content: 'Bridge: ' + msg,
      });
      await this.finalizeStream();
      return;
    }

    // Abort if a newer send superseded this one (shouldn't happen, but safe)
    if (this.streamingMsgId !== assistantId) return;

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
    // When new session, optionally include our local live history (text only —
    // do not re-inject prior tools/thinking into the prompt).
    let history: HistoryMessage[] | undefined;
    if (!resume && useHistory) {
      history = this.liveMessages
        .filter((m) => m.id !== assistantId && m.id !== userMsg.id)
        .filter((m) => !m.excludedFromContext)
        .filter((m) => !(m.role === 'assistant' && m.metadata?.streaming))
        .slice(-30)
        .map((m) => ({
          role: m.role,
          content: m.content || '',
        }))
        .filter((m) => m.content.trim());
    }

    const selectedModel =
      model || cfg.get<string>('defaultModel', 'gb:grok-4.5') || 'gb:grok-4.5';
    const reasoningEffort = normalizeReasoningEffort(
      cfg.get<string>('reasoningEffort', 'high')
    );

    if (this.streamingMsgId !== assistantId) return;

    // Accept events only after prompt is sent, and enable WS mid-stream resume
    this.streamAcceptEvents = true;
    this.client.setStreamingSession(sessionId);

    const ok = this.client.sendPrompt({
      prompt,
      session_id: sessionId,
      // Always the bare user text — system/notes go via `notes` / Grok session.
      model: selectedModel,
      reasoning_effort: reasoningEffort,
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
    const sessionId = this.streamSessionId || this.store.getActiveSessionId();
    if (!sessionId || !this.stream.streaming) {
      this.post({ type: 'toast', level: 'info', text: 'Nothing to stop' });
      return;
    }
    const ok = this.client.stop(sessionId);
    if (!ok) {
      this.post({ type: 'toast', level: 'error', text: 'Could not send stop (WS down)' });
      // Still finalize locally so UI unlocks
    }
    this.streamAcceptEvents = true;
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
    this.persistLive(this.store.getActiveSessionId(), true);
    await this.pushFullState();
  }

  async deleteMessage(messageId: string): Promise<void> {
    this.liveMessages = this.liveMessages.filter((m) => m.id !== messageId);
    this.persistLive(this.store.getActiveSessionId(), true);
    await this.pushFullState();
  }

  async newSession(): Promise<void> {
    this.endStreamEpoch();
    const id = newGrokSessionId();
    await this.store.setActiveSessionId(id);
    this.store.ensureMirror(id);
    this.liveMessages = [];
    await this.pushFullState();
  }

  async switchSession(id: string): Promise<void> {
    this.endStreamEpoch();
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
    this.store.deleteSession(id);
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

  async setReasoningEffort(effort: string): Promise<void> {
    const value = normalizeReasoningEffort(effort);
    await vscode.workspace
      .getConfiguration('vsgrok')
      .update('reasoningEffort', value, vscode.ConfigurationTarget.Global);
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

  /**
   * After activation / panel open: if the last assistant message was mid-stream,
   * try to reattach to a still-running bridge agent and restore the bubble.
   */
  async tryResumeIncompleteStream(): Promise<void> {
    if (this.stream.streaming) return;
    const sessionId = this.store.getActiveSessionId();
    if (!sessionId || !this.liveMessages.length) return;
    const last = this.liveMessages[this.liveMessages.length - 1];
    if (last?.role !== 'assistant' || !last.metadata?.streaming) return;

    this.beginStreamEpoch(sessionId, last.id);
    // Rebuild stream shell from last snapshot
    if (last.metadata.timeline?.length) {
      this.stream.timeline = last.metadata.timeline.map((s) => ({ ...s }));
      this.stream.fullText = last.content || '';
      this.stream.thinkingSummary = last.metadata.thinking || '';
      this.stream.toolCount = last.metadata.tool_count || 0;
    }
    this.streamAcceptEvents = true;
    this.client.setStreamingSession(sessionId);
    try {
      await this.ensureBridge();
      // Explicit reconnect in case connect() already fired without streamingSessionId
      this.client.reconnect(sessionId);
    } catch (err) {
      this.output.appendLine(`[resume] ${err}`);
      // Mark interrupted but keep partial content
      this.stream = reduceStreamEvent(this.stream, {
        type: 'interrupted',
        content: this.stream.fullText || last.content,
        reason: 'resume_failed',
      });
      await this.finalizeStream();
      return;
    }
    await this.pushFullState();
    this.post({ type: 'stream', payload: this.stream });
  }

  dispose(): void {
    const sid = this.streamSessionId || this.store.getActiveSessionId();
    if (sid && this.liveMessages.length) {
      this.persistLive(sid, true);
    }
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.client.disconnect();
  }
}

const REASONING_EFFORTS = new Set(['low', 'medium', 'high']);

function normalizeReasoningEffort(value: unknown): 'low' | 'medium' | 'high' {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  if (REASONING_EFFORTS.has(v)) return v as 'low' | 'medium' | 'high';
  return 'high';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
