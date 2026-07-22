import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ChatController } from '../chat/ChatController';
import { ApplyService, extractFileEdits } from '../apply/ApplyService';

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'vsgrok.chatView';
  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly controller: ChatController,
    private readonly applyService: ApplyService
  ) {
    this.controller.setPoster((msg) => {
      this.view?.webview.postMessage(msg);
    });
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview-media')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'src', 'webview', 'media')),
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
      ],
    };
    webview.html = this.getHtml(webview);

    webview.onDidReceiveMessage(async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        webview.postMessage({ type: 'toast', level: 'error', text });
      }
    });

    void this.controller.pushFullState();
  }

  private postToWebview(msg: { type: string; [k: string]: unknown }): void {
    this.view?.webview.postMessage(msg);
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }): Promise<void> {
    switch (msg.type) {
      case 'ready':
        // Auto-start / reconnect bridge when the panel opens
        try {
          await this.controller.ensureBridge();
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.postToWebview({
            type: 'toast',
            level: 'error',
            text: 'Bridge: ' + text,
          });
        }
        await this.controller.pushFullState();
        // Reattach mid-stream turns after IDE reload / webview recreate
        await this.controller.tryResumeIncompleteStream();
        break;
      case 'startBridge':
        try {
          await this.controller.ensureBridge();
          await this.controller.pushFullState();
          this.postToWebview({
            type: 'toast',
            level: 'info',
            text: 'Bridge connected',
          });
        } catch (err) {
          const text = err instanceof Error ? err.message : String(err);
          this.postToWebview({
            type: 'toast',
            level: 'error',
            text: 'Bridge: ' + text,
          });
        }
        break;
      case 'send':
        await this.controller.send(String(msg.text || ''), msg.model ? String(msg.model) : undefined);
        break;
      case 'stop':
        await this.controller.stopGeneration();
        break;
      case 'excludeMessage':
        await this.controller.toggleExcludeMessage(
          String(msg.id || ''),
          msg.excluded !== undefined ? !!msg.excluded : undefined
        );
        break;
      case 'deleteMessage':
        await this.controller.deleteMessage(String(msg.id || ''));
        break;
      case 'newSession':
        await this.controller.newSession();
        break;
      case 'switchSession':
        await this.controller.switchSession(String(msg.id || ''));
        break;
      case 'deleteSession':
        await this.controller.deleteSession(String(msg.id || ''));
        break;
      case 'renameSession':
        await this.controller.renameSession(String(msg.id || ''), String(msg.title || ''));
        break;
      case 'setModel':
        await this.controller.setModel(String(msg.model || ''));
        break;
      case 'setReasoningEffort':
        await this.controller.setReasoningEffort(String(msg.effort || msg.value || ''));
        break;
      case 'setSetting':
        await this.controller.setSetting(String(msg.key || ''), !!msg.value);
        break;
      case 'saveNotes':
        await this.controller.saveNotes(
          (msg.notes as { id: string; text: string; enabled: boolean }[]) || []
        );
        break;
      case 'refreshUsage':
        await this.controller.refreshUsage(true);
        break;
      case 'loginGrok':
        await this.controller.loginGrok();
        break;
      case 'applyMarkdown': {
        await this.applyService.applyFromMarkdown(String(msg.markdown || ''));
        break;
      }
      case 'previewMarkdown': {
        const edits = extractFileEdits(String(msg.markdown || ''));
        this.applyService.remember(edits);
        await this.applyService.preview(edits);
        break;
      }
      case 'openExternal':
        if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(String(msg.url)));
        break;
      default:
        break;
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const mediaRoot = path.join(this.context.extensionPath, 'dist', 'webview-media');
    const srcMedia = path.join(this.context.extensionPath, 'src', 'webview', 'media');
    const root = fs.existsSync(path.join(mediaRoot, 'chat.js')) ? mediaRoot : srcMedia;
    const cssUri = webview.asWebviewUri(vscode.Uri.file(path.join(root, 'chat.css')));
    const jsUri = webview.asWebviewUri(vscode.Uri.file(path.join(root, 'chat.js')));
    const nonce = String(Date.now());
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} https: data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${cssUri}" />
  <title>VSGrok</title>
</head>
<body>
  <div id="app" class="sc-root">
    <div id="bridgeWarn" class="sc-bridge-warn hidden">Bridge offline — use Start bridge in Settings.</div>
    <div class="sc-topbar">
      <span class="sc-topbar-title" id="topbarTitle">New Chat</span>
      <span class="sc-status-dot" id="statusDot" title="WebSocket"></span>
      <button type="button" class="sc-usage-chip" id="usageChip" title="Grok Build weekly usage">Usage …</button>
    </div>
    <div id="loginBanner" class="sc-banner hidden"></div>
    <div class="sc-scroll" id="scroll">
      <div id="messages" class="sc-messages"></div>
      <div id="stream" class="sc-stream-slot"></div>
    </div>

    <div class="sc-toolbar">
      <div class="sc-wrap" id="historyWrap">
        <button type="button" class="sc-toolbar-btn" id="btnHistory">History</button>
        <div class="sc-popover" id="historyPopover">
          <div class="sc-popover-header">
            <span>Sessions</span>
            <button type="button" class="sc-link-btn" id="btnNew">+ New</button>
          </div>
          <div class="sc-popover-body" id="sessionList"></div>
        </div>
      </div>
      <button type="button" class="sc-toolbar-btn active" id="btnContext" title="Include IDE context">Context</button>
      <div class="sc-wrap" id="notesWrap">
        <button type="button" class="sc-toolbar-btn" id="btnNotes">Notes <span id="notesBadge" class="sc-badge hidden"></span></button>
        <div class="sc-popover" id="notesPopover" style="min-width:280px">
          <div class="sc-popover-header"><span>Instructions</span></div>
          <div class="sc-popover-body" id="notesList"></div>
          <div class="sc-notes-add">
            <input type="text" id="notesInput" maxlength="500" placeholder="New instruction…" />
            <button type="button" id="notesAdd">Add</button>
          </div>
        </div>
      </div>
      <div class="sc-toolbar-spacer"></div>
      <div class="sc-wrap" id="settingsWrap">
        <button type="button" class="sc-toolbar-btn" id="btnSettings">Settings</button>
        <div class="sc-popover sc-settings-popover" id="settingsPopover">
          <div class="sc-popover-header">Settings</div>
          <div class="sc-settings-body">
            <div id="usageDetail" class="sc-usage-detail">
              <div class="sc-usage-detail-head">
                <div>
                  <div class="sc-usage-detail-title">Weekly usage</div>
                  <span class="sc-usage-detail-tier" id="usageTier" hidden></span>
                </div>
                <button type="button" class="sc-usage-refresh" id="usageRefresh">Refresh</button>
              </div>
              <div class="sc-usage-detail-body" id="usageBody">Loading…</div>
            </div>
            <label class="sc-settings-label" for="modelSelect">Model</label>
            <select id="modelSelect" class="sc-select"></select>
            <label class="sc-settings-label" for="effortSelect">Reasoning effort</label>
            <select id="effortSelect" class="sc-select">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>

            <div class="sc-settings-section">CHAT</div>
            <label class="sc-setting-row">
              <span class="sc-setting-text">
                <span class="sc-setting-title">Send history / context</span>
                <span class="sc-setting-sub">Include prior messages when not resuming a Grok session</span>
              </span>
              <input type="checkbox" id="setHistory" class="sc-setting-check" checked />
            </label>
            <label class="sc-setting-row">
              <span class="sc-setting-text">
                <span class="sc-setting-title">Enter for newline</span>
                <span class="sc-setting-sub">Enter inserts a line; send with Ctrl+Enter</span>
              </span>
              <input type="checkbox" id="setEnterNewline" class="sc-setting-check" checked />
            </label>
            <label class="sc-setting-row">
              <span class="sc-setting-text">
                <span class="sc-setting-title">Show tools</span>
                <span class="sc-setting-sub">Tool call cards in the transcript</span>
              </span>
              <input type="checkbox" id="setShowTools" class="sc-setting-check" checked />
            </label>
            <label class="sc-setting-row">
              <span class="sc-setting-text">
                <span class="sc-setting-title">Show thoughts</span>
                <span class="sc-setting-sub">Thinking cards in the transcript</span>
              </span>
              <input type="checkbox" id="setShowThoughts" class="sc-setting-check" checked />
            </label>

            <div class="sc-settings-section">BRIDGE</div>
            <button type="button" class="sc-toolbar-btn" id="btnLogin" style="width:100%;justify-content:center">Login to Grok</button>
            <button type="button" class="sc-toolbar-btn" id="btnBridge" style="width:100%;justify-content:center;margin-top:6px">Start / reconnect bridge</button>
            <button type="button" class="sc-toolbar-btn" id="btnApply" style="width:100%;justify-content:center;margin-top:6px">Apply last code blocks</button>
          </div>
        </div>
      </div>
    </div>

    <div class="sc-input-area">
      <div class="sc-input-wrap">
        <textarea id="prompt" rows="2" placeholder="Message Grok Build… (@file, @selection, @open)"></textarea>
        <button type="button" class="sc-stop-btn hidden" id="btnStop" title="Stop generation">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
        </button>
        <button type="button" class="sc-send-btn" id="btnSend" disabled title="Send">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
  }
}
