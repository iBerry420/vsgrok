import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayUserText } from './GrokSessions';

describe('displayUserText', () => {
  it('extracts bare text from bridge [User] wrapper', () => {
    const raw = `<user_query>
When you reply, write only your new answer. Do not repeat prior lines unless asked.

<additional_notes>
- Workspace root: /tmp
</additional_notes>

[User]: hello world
</user_query>`;
    assert.equal(displayUserText(raw), 'hello world');
  });

  it('keeps full message when user quotes [User]: mid-line', () => {
    const raw = `<user_query>
When you reply, write only your new answer. Do not repeat prior lines unless asked.

[User]: display text after the "[User]: " since thats where my message is
</user_query>`;
    assert.equal(
      displayUserText(raw),
      'display text after the "[User]: " since thats where my message is'
    );
  });

  it('returns plain user_query content', () => {
    assert.equal(
      displayUserText('<user_query>\nlets build a chat extension\n</user_query>'),
      'lets build a chat extension'
    );
  });

  it('hides system-reminder only rows', () => {
    const raw = `<system-reminder>
The following skills are available for use:
- help
</system-reminder>`;
    assert.equal(displayUserText(raw), '');
  });

  it('hides user_info only rows', () => {
    const raw = `<user_info>
OS Version: linux
Workspace Path: /tmp
</user_info>`;
    assert.equal(displayUserText(raw), '');
  });

  it('passes through plain user text unchanged', () => {
    assert.equal(displayUserText('just a normal message'), 'just a normal message');
  });
});
