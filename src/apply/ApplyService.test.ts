import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFileEdits } from './extractEdits';

test('extracts path from fence infostring', () => {
  const md = 'Here:\n\n```src/foo.ts\nexport const x = 1;\n```\n';
  const edits = extractFileEdits(md);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, 'src/foo.ts');
  assert.match(edits[0].content, /export const x/);
});

test('extracts lang + path fence', () => {
  const md = '```typescript src/bar.ts\nconst y = 2;\n```';
  const edits = extractFileEdits(md);
  assert.equal(edits.length, 1);
  assert.equal(edits[0].path, 'src/bar.ts');
});

test('ignores bare language fences', () => {
  const md = '```ts\nconst z = 3;\n```';
  const edits = extractFileEdits(md);
  assert.equal(edits.length, 0);
});
