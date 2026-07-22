import type { ChatMessage } from './types';

/**
 * Merge Grok on-disk history with the extension-local mirror.
 * Grok is preferred for completed turns; local-only tails (not yet flushed)
 * and richer local metadata are preserved.
 */
export function mergeTranscripts(
  grok: ChatMessage[],
  local: ChatMessage[]
): ChatMessage[] {
  if (!local.length) return grok.slice();
  if (!grok.length) return local.slice();

  const keyOf = (m: ChatMessage): string => {
    const c = (m.content || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    return `${m.role}:${c}`;
  };

  const grokKeys = new Set(grok.map(keyOf));
  const merged: ChatMessage[] = grok.map((g) => {
    // Prefer local timeline/metadata when content matches and local is richer
    const k = keyOf(g);
    const loc = local.find((l) => keyOf(l) === k);
    if (
      loc &&
      loc.metadata?.timeline &&
      (!g.metadata?.timeline ||
        loc.metadata.timeline.length > (g.metadata.timeline?.length || 0))
    ) {
      return {
        ...g,
        metadata: { ...g.metadata, ...loc.metadata, streaming: false },
        content: g.content || loc.content,
      };
    }
    return g;
  });

  // Append local tail that Grok has not flushed yet
  for (const m of local) {
    if (
      m.role === 'assistant' &&
      m.metadata?.streaming &&
      !m.content &&
      !m.metadata.timeline?.length
    ) {
      // empty streaming stub without content — skip if Grok already advanced past it
      continue;
    }
    const k = keyOf(m);
    if (!k.endsWith(':') && grokKeys.has(k)) continue;
    // Local-only user turn or incomplete assistant with partial content
    if (m.role === 'user' && m.content.trim() && !grokKeys.has(k)) {
      merged.push(m);
      continue;
    }
    if (m.role === 'assistant' && (m.content || m.metadata?.timeline?.length)) {
      const already = merged.some(
        (x) =>
          x.role === 'assistant' &&
          (x.content === m.content ||
            (m.content &&
              x.content &&
              x.content.includes(m.content.slice(0, 80))))
      );
      if (!already) {
        merged.push({
          ...m,
          metadata: { ...m.metadata, streaming: !!m.metadata?.streaming },
        });
      }
    }
  }

  return merged;
}
