export type Mention =
  | { kind: 'file'; raw: string; path: string }
  | { kind: 'selection'; raw: string }
  | { kind: 'open'; raw: string };

const MENTION_RE = /(?:^|\s)@([^\s]+)/g;

/**
 * Parse @mentions from a prompt.
 * - @selection
 * - @open
 * - @path/to/file (relative or absolute-looking)
 */
export function parseMentions(text: string): Mention[] {
  const out: Mention[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(MENTION_RE.source, 'g');
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (key === 'selection') {
      out.push({ kind: 'selection', raw });
    } else if (key === 'open') {
      out.push({ kind: 'open', raw });
    } else {
      out.push({ kind: 'file', raw, path: raw });
    }
  }
  return out;
}

export function stripMentionsForDisplay(text: string): string {
  return text.replace(/(?:^|\s)@([^\s]+)/g, (full) => full.replace(/@\S+/, '').trimEnd()).trim();
}
