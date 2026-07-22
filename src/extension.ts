import * as vscode from 'vscode';
import { BridgeManager } from './bridge/BridgeManager';
import { SessionStore } from './chat/SessionStore';
import { ChatController } from './chat/ChatController';
import { ChatViewProvider } from './webview/ChatViewProvider';
import { ApplyService, extractFileEdits } from './apply/ApplyService';

let bridge: BridgeManager | undefined;
let controller: ChatController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('VSGrok');
  context.subscriptions.push(output);

  // Ensure storage dirs exist
  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  if (context.storageUri) {
    await vscode.workspace.fs.createDirectory(context.storageUri);
  }

  bridge = new BridgeManager(context, output);
  const store = new SessionStore(context);
  const applyService = new ApplyService();
  controller = new ChatController(store, bridge, applyService, output);

  const provider = new ChatViewProvider(context, controller, applyService);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'vsgrok.openChat';
  status.text = '$(comment-discussion) VSGrok';
  status.tooltip = 'Open VSGrok chat';
  status.show();
  context.subscriptions.push(status);

  const setStatus = (text: string) => {
    status.text = text;
  };

  bridge.on('ready', (port: number) => {
    setStatus(`$(broadcast) VSGrok :${port}`);
    void controller?.connectClient().then(() => controller?.pushFullState());
  });
  bridge.on('exit', () => setStatus('$(circle-slash) VSGrok'));

  context.subscriptions.push(
    vscode.commands.registerCommand('vsgrok.openChat', async () => {
      // Right-side secondary sidebar (auxiliary bar)
      try {
        await vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
      } catch {
        /* older builds */
      }
      await vscode.commands.executeCommand('vsgrok.chatView.focus');
    }),
    vscode.commands.registerCommand('vsgrok.newSession', async () => {
      await controller?.newSession();
    }),
    vscode.commands.registerCommand('vsgrok.startBridge', async () => {
      try {
        await bridge?.start();
        await controller?.connectClient();
        await controller?.pushFullState();
        void vscode.window.showInformationMessage(
          `VSGrok bridge on ${bridge?.httpBase || '…'}`
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[error] ${msg}`);
        void vscode.window.showErrorMessage(`VSGrok bridge failed: ${msg}`);
      }
    }),
    vscode.commands.registerCommand('vsgrok.stopBridge', async () => {
      controller?.disconnectClient();
      await bridge?.stop();
      setStatus('$(circle-slash) VSGrok');
      await controller?.pushFullState();
      void vscode.window.showInformationMessage('VSGrok bridge stopped');
    }),
    vscode.commands.registerCommand('vsgrok.loginGrok', async () => {
      await controller?.loginGrok();
    }),
    vscode.commands.registerCommand('vsgrok.addSelection', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed || ed.selection.isEmpty) {
        void vscode.window.showInformationMessage('No selection');
        return;
      }
      controller?.pinSelection(ed.document.getText(ed.selection));
      await vscode.commands.executeCommand('vsgrok.chatView.focus');
      void vscode.window.showInformationMessage('Selection pinned for next VSGrok message');
    }),
    vscode.commands.registerCommand('vsgrok.addActiveFile', async () => {
      const ed = vscode.window.activeTextEditor;
      if (!ed) return;
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const p = root
        ? require('path').relative(root, ed.document.uri.fsPath)
        : ed.document.uri.fsPath;
      controller?.pinPath(p);
      await vscode.commands.executeCommand('vsgrok.chatView.focus');
      void vscode.window.showInformationMessage(`Pinned ${p} for next VSGrok message`);
    }),
    vscode.commands.registerCommand('vsgrok.applyLastDiff', async () => {
      const edits = applyService.getLastEdits();
      if (!edits.length) {
        // try extract from active session last assistant message
        const id = store.getActiveSessionId();
        const session = id ? store.loadSession(id) : null;
        const last = [...(session?.messages || [])]
          .reverse()
          .find((m) => m.role === 'assistant' && m.content);
        if (last) {
          applyService.remember(extractFileEdits(last.content));
        }
      }
      await applyService.apply(applyService.getLastEdits());
    })
  );

  const auto = vscode.workspace.getConfiguration('vsgrok').get<boolean>('autoStartBridge', true);
  if (auto) {
    // Fire-and-forget so activate is never blocked if bridge is slow
    void (async () => {
      try {
        output.appendLine('[bridge] auto-start…');
        await bridge!.start();
        await controller!.connectClient();
        await controller!.pushFullState();
        output.appendLine(`[bridge] auto-start OK ${bridge!.httpBase}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[bridge auto-start failed] ${msg}`);
        void vscode.window.showWarningMessage(
          `VSGrok: bridge failed to start — ${msg}. Check Output → VSGrok, or run “VSGrok: Start Bridge”.`
        );
        try {
          await controller?.pushFullState();
        } catch {
          /* ignore */
        }
      }
    })();
  }

  output.appendLine('VSGrok activated');
}

export async function deactivate(): Promise<void> {
  // Flush local transcript mirror before unload
  controller?.dispose();
  await bridge?.dispose();
}
