import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { extractFileEdits, type FileEdit } from './extractEdits';

export type { FileEdit };
export { extractFileEdits };

export class ApplyService {
  private lastEdits: FileEdit[] = [];

  getLastEdits(): FileEdit[] {
    return this.lastEdits;
  }

  remember(edits: FileEdit[]): void {
    this.lastEdits = edits;
  }

  async preview(edits: FileEdit[]): Promise<void> {
    if (!edits.length) {
      void vscode.window.showInformationMessage('No file edits found in the last reply.');
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const edit of edits) {
      const abs = path.isAbsolute(edit.path)
        ? edit.path
        : path.join(root || '', edit.path);
      let original = '';
      try {
        original = fs.readFileSync(abs, 'utf8');
      } catch {
        original = '';
      }
      const left = await vscode.workspace.openTextDocument({
        content: original,
        language: languageFor(abs),
      });
      const right = await vscode.workspace.openTextDocument({
        content: edit.content,
        language: languageFor(abs),
      });
      await vscode.commands.executeCommand(
        'vscode.diff',
        left.uri,
        right.uri,
        `VSGrok: ${edit.path}`
      );
    }
  }

  async apply(edits: FileEdit[], opts?: { confirm?: boolean }): Promise<number> {
    if (!edits.length) return 0;
    this.lastEdits = edits;
    if (opts?.confirm !== false) {
      const ok = await vscode.window.showWarningMessage(
        `Apply ${edits.length} file change(s)?`,
        { modal: true },
        'Apply'
      );
      if (ok !== 'Apply') return 0;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let count = 0;
    const we = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      const abs = path.isAbsolute(edit.path)
        ? edit.path
        : path.join(root || '', edit.path);
      const uri = vscode.Uri.file(abs);
      const dir = path.dirname(abs);
      fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(abs)) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const full = new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length)
        );
        we.replace(uri, full, edit.content);
      } else {
        we.createFile(uri, { ignoreIfExists: true });
        we.insert(uri, new vscode.Position(0, 0), edit.content);
      }
      count++;
    }
    await vscode.workspace.applyEdit(we);
    void vscode.window.showInformationMessage(`VSGrok applied ${count} file(s).`);
    return count;
  }

  async applyFromMarkdown(markdown: string): Promise<number> {
    const edits = extractFileEdits(markdown);
    this.lastEdits = edits;
    return this.apply(edits);
  }
}

function languageFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.json': 'json',
    '.md': 'markdown',
    '.py': 'python',
    '.rs': 'rust',
    '.go': 'go',
    '.css': 'css',
    '.html': 'html',
    '.sh': 'shellscript',
  };
  return map[ext] || 'plaintext';
}
