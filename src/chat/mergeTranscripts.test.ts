import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTranscripts } from './mergeTranscripts';
import type { ChatMessage } from './types';

function msg(
  role: ChatMessage['role'],
  content: string,
  extra?: Partial<ChatMessage>
): ChatMessage {
  return {
    id: Math.random().toString(16).slice(2),
    role,
    content,
    createdAt: Date.now(),
    ...extra,
  };
}

test('mergeTranscripts keeps local-only user turns until Grok flushes', () => {
  const grok = [msg('user', 'hello'), msg('assistant', 'hi there')];
  const local = [
    ...grok,
    msg('user', 'second question'),
    msg('assistant', 'partial', {
      metadata: { streaming: true, timeline: [{ type: 'thinking', content: 'hmm', done: false }] },
    }),
  ];
  const merged = mergeTranscripts(grok, local);
  assert.equal(merged.length, 4);
  assert.equal(merged[2].content, 'second question');
  assert.equal(merged[3].role, 'assistant');
  assert.ok(merged[3].metadata?.timeline?.length);
});

test('mergeTranscripts prefers richer local timeline for matching content', () => {
  const grok = [
    msg('user', 'q'),
    msg('assistant', 'answer'),
  ];
  const local = [
    msg('user', 'q'),
    msg('assistant', 'answer', {
      metadata: {
        timeline: [
          { type: 'thinking', content: 'reason', done: true },
          { type: 'text', content: 'answer' },
        ],
        thinking: 'reason',
      },
    }),
  ];
  const merged = mergeTranscripts(grok, local);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].metadata?.thinking, 'reason');
  assert.equal(merged[1].metadata?.timeline?.length, 2);
});

test('mergeTranscripts returns grok when local empty', () => {
  const grok = [msg('user', 'only')];
  assert.deepEqual(
    mergeTranscripts(grok, []).map((m) => m.content),
    ['only']
  );
});
