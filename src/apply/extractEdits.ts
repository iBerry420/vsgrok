export type FileEdit = {
  path: string;
  content: string;
  mode: 'write' | 'patch';
};

const FENCE_RE = /```([^\n`]*)\n([\s\S]*?)```/g;

/**
 * Extract proposed file writes from assistant markdown.
 * Supports:
 * - ```path/to/file.ts
 * - ```ts path/to/file.ts
 * - ```typescript:src/foo.ts
 */
export function extractFileEdits(markdown: string): FileEdit[] {
  const edits: FileEdit[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(FENCE_RE.source, 'g');
  while ((m = re.exec(markdown)) !== null) {
    const info = (m[1] || '').trim();
    const body = m[2] || '';
    const filePath = pathFromInfostring(info);
    if (!filePath) continue;
    if (!looksLikeSourcePath(filePath)) continue;
    edits.push({ path: filePath, content: body.replace(/\n$/, ''), mode: 'write' });
  }

  const patchBlocks = markdown.split('*** Begin Patch');
  for (let i = 1; i < patchBlocks.length; i++) {
    const block = patchBlocks[i].split('*** End Patch')[0] || '';
    const fileMatch = block.match(/\*\*\* (?:Update|Add) File:\s*(.+)/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1].trim();
    const withoutHeader = block.replace(/\*\*\* (?:Update|Add) File:.*\n/, '');
    if (withoutHeader.includes('@@')) {
      continue;
    }
    edits.push({
      path: filePath,
      content: withoutHeader.replace(/^\+/gm, '').trimEnd(),
      mode: 'write',
    });
  }

  return dedupeEdits(edits);
}

function pathFromInfostring(info: string): string | null {
  if (!info) return null;
  if (/^[./\w-]+(?:\/[\w./-]+)+\.\w+$/.test(info) || /^\w[\w./-]*\.\w+$/.test(info)) {
    return info;
  }
  const parts = info.split(/\s+/);
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    if (looksLikeSourcePath(last)) return last;
  }
  const colon = info.indexOf(':');
  if (colon > 0) {
    const p = info.slice(colon + 1).trim();
    if (looksLikeSourcePath(p)) return p;
  }
  return null;
}

function looksLikeSourcePath(p: string): boolean {
  if (!p || p.includes('..')) return false;
  if (p.startsWith('http:') || p.startsWith('https:')) return false;
  return /\.\w{1,12}$/.test(p) && !/\s/.test(p);
}

function dedupeEdits(edits: FileEdit[]): FileEdit[] {
  const map = new Map<string, FileEdit>();
  for (const e of edits) map.set(e.path.replace(/\\/g, '/'), e);
  return [...map.values()];
}
