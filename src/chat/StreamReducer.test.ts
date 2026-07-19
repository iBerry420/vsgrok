import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createStreamState,
  historyContentFromMessage,
  reduceStreamEvent,
} from './StreamReducer';

test('thinking + chunk + tool timeline', () => {
  let s = createStreamState();
  s = reduceStreamEvent(s, { type: 'init', model: 'gb:grok-4.5' });
  assert.equal(s.streaming, true);
  assert.equal(s.model, 'gb:grok-4.5');

  s = reduceStreamEvent(s, { type: 'thinking_delta', content: 'hmm ' });
  s = reduceStreamEvent(s, { type: 'thinking_delta', content: 'yes' });
  s = reduceStreamEvent(s, { type: 'thinking_done' });
  s = reduceStreamEvent(s, {
    type: 'tool_start',
    tool: 'read_file',
    detail: 'foo.ts',
  });
  s = reduceStreamEvent(s, {
    type: 'tool_done',
    tool: 'read_file',
    success: true,
    info: 'ok',
  });
  s = reduceStreamEvent(s, { type: 'chunk', content: 'Hello ' });
  s = reduceStreamEvent(s, { type: 'chunk', content: 'world' });
  s = reduceStreamEvent(s, {
    type: 'done',
    content: 'Hello world',
    duration: 1200,
  });

  assert.equal(s.done, true);
  assert.equal(s.streaming, false);
  assert.equal(s.fullText, 'Hello world');
  assert.equal(s.timeline.length, 3);
  assert.equal(s.timeline[0].type, 'thinking');
  assert.equal(s.timeline[1].type, 'tool');
  assert.equal(s.timeline[2].type, 'text');
  if (s.timeline[2].type === 'text') {
    assert.equal(s.timeline[2].content, 'Hello world');
  }
});

test('text_replace replaces trailing text segment', () => {
  let s = createStreamState();
  s = reduceStreamEvent(s, { type: 'chunk', content: 'old' });
  s = reduceStreamEvent(s, { type: 'text_replace', content: 'new full' });
  assert.equal(s.fullText, 'new full');
  assert.equal(s.timeline.length, 1);
});

test('historyContentFromMessage expands timeline', () => {
  const content = historyContentFromMessage('fallback', {
    timeline: [
      { type: 'thinking', content: 't1' },
      { type: 'tool', tool: 'x', detail: 'd', success: true, info: 'ok' },
      { type: 'text', content: 'answer' },
    ],
  });
  assert.match(content, /<thinking>/);
  assert.match(content, /\[x\]/);
  assert.match(content, /answer/);
});

test('agent_resume clears timeline for replay', () => {
  let s = createStreamState();
  s = reduceStreamEvent(s, { type: 'chunk', content: 'partial' });
  s = reduceStreamEvent(s, { type: 'agent_resume', message_id: 42 });
  assert.equal(s.streaming, true);
  assert.equal(s.fullText, '');
  assert.equal(s.timeline.length, 0);
  assert.equal(s.messageId, 42);
});
