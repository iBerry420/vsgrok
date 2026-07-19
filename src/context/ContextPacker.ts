import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { parseMentions } from './Mentions';

export type PackedContext = {
  notes: string[];
  chips: { label: string; detail?: string }[];
  bytes: number;
};

/**
 * Collect IDE context for injection as bridge `notes`.
 */
export async function packContext(
  prompt: string,
  opts?: {
    includeSelection?: boolean;
    maxBytes?: number;
    pinnedPaths?: string[];
    pinnedSelection?: string | null;
  }
): Promise<PackedContext> {
  const maxBytes = opts?.maxBytes ?? 80000;
  const includeSelection = opts?.includeSelection !== false;
  const notes: string[] = [];
  const chips: { label: string; detail?: string }[] = [];
  let used = 0;

  const budget = (s: string) => {
    const n = Buffer.byteLength(s, 'utf8');
    if (used + n > maxBytes) return false;
    used += n;
    return true;
  };

  const workspace = vscode.workspace.workspaceFolders?.[0];
  const root = workspace?.uri.fsPath;

  // Workspace root note
  if (root) {
    const line = `Workspace root: ${root}`;
    if (budget(line)) notes.push(line);
  }

  // Active editor path
  const editor = vscode.window.activeTextEditor;
  if (editor) {
    const rel = root
      ? path.relative(root, editor.document.uri.fsPath)
      : editor.document.uri.fsPath;
    const line = `Active file: ${rel} (lang=${editor.document.languageId})`;
    if (budget(line)) {
      notes.push(line);
      chips.push({ label: rel, detail: 'active' });
    }
  }

  // Selection
  const selText =
    opts?.pinnedSelection ??
    (includeSelection && editor && !editor.selection.isEmpty
      ? editor.document.getText(editor.selection)
      : '');
  if (selText && selText.trim()) {
    const block = `<editor_selection>\n${truncate(selText, 12000)}\n</editor_selection>`;
    if (budget(block)) {
      notes.push(block);
      chips.push({ label: 'selection', detail: `${selText.length} chars` });
    }
  }

  const mentions = parseMentions(prompt);
  const wantOpen = mentions.some((m) => m.kind === 'open');
  const fileMentions = mentions.filter((m) => m.kind === 'file').map((m) => m.path);
  const paths = unique([...(opts?.pinnedPaths || []), ...fileMentions]);

  for (const p of paths) {
    if (!root && !path.isAbsolute(p)) continue;
    const abs = path.isAbsolute(p) ? p : path.join(root!, p);
    try {
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > 400_000) continue;
      const content = fs.readFileSync(abs, 'utf8');
      const rel = root ? path.relative(root, abs) : abs;
      const block = `<file path="${rel}">\n${truncate(content, 20000)}\n</file>`;
      if (budget(block)) {
        notes.push(block);
        chips.push({ label: rel, detail: 'file' });
      }
    } catch {
      /* skip missing */
    }
  }

  if (wantOpen) {
    const docs = vscode.workspace.textDocuments.filter((d) => d.uri.scheme === 'file').slice(0, 8);
    for (const doc of docs) {
      const rel = root ? path.relative(root, doc.uri.fsPath) : doc.uri.fsPath;
      const snippet = truncate(doc.getText(), 4000);
      const block = `<open_file path="${rel}">\n${snippet}\n</open_file>`;
      if (budget(block)) {
        notes.push(block);
        chips.push({ label: rel, detail: 'open' });
      }
    }
  }

  // Diagnostics for active file
  if (editor) {
    const diags = vscode.languages.getDiagnostics(editor.document.uri).filter(
      (d) => d.severity <= vscode.DiagnosticSeverity.Warning
    );
    if (diags.length) {
      const lines = diags.slice(0, 30).map((d) => {
        const r = d.range.start;
        const sev = d.severity === vscode.DiagnosticSeverity.Error ? 'error' : 'warning';
        return `${sev} L${r.line + 1}:${r.character + 1} ${d.message}`;
      });
      const block = `<diagnostics>\n${lines.join('\n')}\n</diagnostics>`;
      if (budget(block)) {
        notes.push(block);
        chips.push({ label: 'diagnostics', detail: String(diags.length) });
      }
    }
  }

  // Git status (short)
  if (root) {
    try {
      const { execSync } = require('child_process') as typeof import('child_process');
      const status = execSync('git status -sb', {
        cwd: root,
        timeout: 2000,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .trim()
        .split('\n')
        .slice(0, 40)
        .join('\n');
      if (status) {
        const block = `<git_status>\n${status}\n</git_status>`;
        if (budget(block)) notes.push(block);
      }
    } catch {
      /* no git */
    }
  }

  return { notes, chips, bytes: used };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…(truncated)';
}

function unique(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of arr) {
    const k = a.replace(/\\/g, '/');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}
