# VSGrok

**Grok Build chat inside VS Code / Cursor** — a highly capable sidebar agent powered by a local WebSocket bridge (forked from [GrokifyOS](https://github.com/iBerry420/grokifyos)).

No PHP. No MySQL. No remote control plane. The extension spawns a Node bridge that runs the **Grok Build CLI** against your open workspace, streams thoughts / tools / markdown, continues the same sessions as the Grok TUI, and can apply code-block diffs into the editor.

> **Not affiliated.** VSGrok is an independent open-source project. It is **not** affiliated with, endorsed by, or sponsored by SpaceXAI/xAI, Grok, or VS Code. Product names are trademarks of their respective owners.

---

## Why VSGrok

Most “AI chat in the editor” add-ons either:

- call a generic chat API with no project tools, or  
- are locked to a single commercial IDE agent.

VSGrok is different:

| | |
|--|--|
| **Your Grok Build login** | Uses the real `grok` CLI + `~/.grok/auth.json` you already have |
| **Your workspace as cwd** | Agents run with tools against the folder you opened |
| **Same sessions as the TUI** | Lists and resumes `~/.grok/sessions/…` for this project (`--resume`) |
| **Local bridge** | Streaming protocol from GrokifyOS — thinking, tools, media, reconnect, stop |
| **IDE-native extras** | Selection / `@file` context, usage chip, apply fences, hover message actions |

---

## Features

### Chat (GrokifyOS-style)

- **Right secondary sidebar** panel (not the left activity bar)
- **Streaming** assistant turns: text, **Thinking / Thoughts**, collapsible **tool** cards, media hooks
- **Full-height transcript** with smart auto-scroll (unlocks when you scroll up)
- **Markdown** in messages *and* thoughts: headings, lists, quotes, code, diffs, clickable links
- **JSON prettify** for tool payloads and fences when content looks like JSON
- **Stop** button to halt an in-flight agent
- **Hover actions** under each bubble: copy · hide from context · delete  
  - User order: delete · hide · copy  
  - AI order: copy · hide · delete
- **Usage chip** + settings breakdown (weekly Grok Build billing %)

### Sessions

- Loaded from **Grok Build** session storage for the current workspace
- **New** → new UUID (`--session-id`)
- **Continue** → `--resume <uuid>` when the session already exists on disk
- History popover lists titles from `summary.json`

### IDE context

Injected as bridge `notes` (size-capped):

- Active file + optional selection  
- `@path/to/file`, `@selection`, `@open`  
- Diagnostics (errors/warnings)  
- Short `git status`  
- User **Notes** (persistent instructions)

### Apply / edit

- Path-tagged fences: ` ```src/foo.ts `  
- Apply / preview via VS Code workspace edits  
- Command: **VSGrok: Apply Last Diff**

---

## Requirements

| Dependency | Notes |
|------------|--------|
| **VS Code 1.85+** or **Cursor** | Separate extension install locations |
| **Node.js 18+** | Used to run the local bridge (`node`, not the Electron binary) |
| **Grok Build CLI** (`grok`) | On `PATH`, or set `vsgrok.grokBin` |
| **Grok login** | `grok login` or `grok login --device-code` |

Optional: `npm` for building/packaging from source.

---

## Quick start (install from source)

```bash
git clone https://github.com/iBerry420/vsgrok.git
cd vsgrok

# One-shot: deps → build → VSIX → install into code + cursor
chmod +x scripts/install-local.sh
./scripts/install-local.sh
```

Then in the editor:

1. **Developer: Reload Window** (or fully restart the app)  
2. Open the **Secondary Side Bar** (right side) — View → Appearance → Secondary Side Bar  
3. Command Palette → **`VSGrok: Open Chat`**  
4. Confirm **@installed vsgrok** is enabled in Extensions  

First open auto-starts the bridge. Status dot should go green when the WebSocket is connected; the usage chip fills when billing is readable.

### Manual package & install

```bash
git clone https://github.com/iBerry420/vsgrok.git
cd vsgrok
npm install
(cd bridge && npm ci)
npm run build

# Package (version from package.json)
npx @vscode/vsce package --no-dependencies

# Install (use the versioned filename that was produced)
code --install-extension ./vsgrok-0.1.16.vsix --force
# or Cursor:
cursor --install-extension ./vsgrok-0.1.16.vsix --force
```

Snap VS Code tip: use an absolute path to the `.vsix` if relative install fails.

---

## Grok Build setup

1. Install the [Grok Build / Grok CLI](https://grok.com) so `grok` is on your PATH.  
2. Authenticate once on the machine:

   ```bash
   grok login
   # headless / remote:
   grok login --device-code
   ```

3. Or from the extension: **VSGrok: Login to Grok** (device-code via the bridge).  
4. Verify:

   ```bash
   grok models
   ```

Auth lives in `~/.grok/auth.json`. VSGrok never uploads credentials; the bridge reads them locally for `/usage` and for spawning `grok`.

---

## Using the chat

| Action | How |
|--------|-----|
| Open panel | **VSGrok: Open Chat** or right secondary sidebar |
| Send | **Ctrl/Cmd+Enter** (default). Optional setting: Enter to send |
| New session | Toolbar **History** → **+ New** |
| Switch session | **History** list (Grok Build sessions for this workspace) |
| Stop agent | **Stop** (square) while streaming |
| Context | **Context** toggle, `@file`, selection pin commands |
| Notes | **Notes** — persistent instructions sent each turn |
| Settings / usage | **Settings** or tap the **usage chip** |
| Message actions | Hover a bubble → icon bar **under** the message |

### Commands

- `VSGrok: Open Chat`
- `VSGrok: New Session`
- `VSGrok: Start Bridge` / `VSGrok: Stop Bridge`
- `VSGrok: Login to Grok`
- `VSGrok: Add Selection to Chat`
- `VSGrok: Add Active File to Chat`
- `VSGrok: Apply Last Diff`

---

## Settings (`vsgrok.*`)

| Setting | Default | Description |
|---------|---------|-------------|
| `grokBin` | `grok` | Path or name of the Grok Build CLI |
| `reasoningEffort` | `high` | Passed to `grok --reasoning-effort` |
| `defaultModel` | `gb:grok-4.5` | Model id (`gb:…`) |
| `autoStartBridge` | `true` | Spawn bridge when the extension activates |
| `bridgePort` | `0` | Listen port (`0` = ephemeral) |
| `includeSelection` | `true` | Attach active selection as context |
| `maxContextBytes` | `80000` | Cap for IDE context notes |
| `showThinking` | `true` | Show Thinking / Thoughts blocks |
| `showTools` | `true` | Show tool call cards |
| `enterToSend` | `false` | If true, Enter sends (Shift+Enter for newline) |
| `useHistory` | `true` | Include history when *not* resuming a Grok session |
| `workspaceDataDir` | `.vsgrok` | Extra workspace data dir (bridge runtime uses **`.storage/`**) |

---

## Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│  VS Code / Cursor                                           │
│  ┌──────────────────┐   postMessage    ┌─────────────────┐  │
│  │ Chat Webview     │ ◄──────────────► │ Extension host  │  │
│  │ (markdown, tools,│                  │ BridgeManager   │  │
│  │  usage, sessions)│                  │ Context / Apply │  │
│  └──────────────────┘                  └────────┬────────┘  │
│                                                 │ WS + HTTP │
│                                        ┌────────▼────────┐  │
│                                        │ Local bridge    │  │
│                                        │ (Node, vendored)│  │
│                                        │ spawn `grok`    │  │
│                                        └────────┬───────┘  │
│                                                 │           │
│                                        workspace folder cwd │
│                                        ~/.grok sessions     │
└─────────────────────────────────────────────────────────────┘
```

| Piece | Path / role |
|-------|-------------|
| Extension | `src/` — TypeScript, esbuild → `dist/extension.js` |
| Webview UI | `src/webview/media/chat.{js,css}` |
| Bridge | `bridge/` — GrokifyOS-derived, **no MySQL**; `.storage/` under the workspace |
| Protocol | Prompt `{ prompt, session_id, model?, history?, notes?, resume? }` · stop · reconnect · stream events |

Runtime data for the bridge (logs, partials, detach runtime) lives in **`workspace/.storage/`** (hidden). Grok’s own chat history remains under **`~/.grok/sessions/`**.

---

## Development

```bash
git clone https://github.com/iBerry420/vsgrok.git
cd vsgrok
npm install
(cd bridge && npm ci)
npm run build          # extension + copy webview assets
npm test               # unit tests (stream, fences, transcripts, displayUserText)
npm run watch          # rebuild on change
```

**F5 Extension Development Host**

1. Open the `vsgrok` folder as the workspace root  
2. Run → **Start Debugging** (`launch.json` builds first)  
3. In the new window, open **VSGrok: Open Chat**  

**Useful scripts**

| Script | Purpose |
|--------|---------|
| `npm run build` | Production bundle |
| `npm test` | Node tests |
| `./scripts/install-local.sh` | Build + VSIX + install |
| `npx @vscode/vsce package --no-dependencies` | Produce `.vsix` |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Buttons dead / blank panel | Reload window; reinstall latest VSIX; check **Output → VSGrok** |
| Status grey, bridge offline | **VSGrok: Start Bridge**. Ensure `node` is on PATH (not only Electron) |
| Auth / empty agent reply | `grok login --device-code` or **Login to Grok** |
| Wrong project / empty sessions | Open a **folder** workspace; sessions are scoped to that cwd |
| Snap `code` can’t install VSIX | Absolute path: `code --install-extension /full/path/to/vsgrok-*.vsix` |
| Cursor missing extension | Install with `cursor --install-extension …` (separate from VS Code) |
| Port conflict | Leave `vsgrok.bridgePort` at `0` (ephemeral) |

Logs: **View → Output → VSGrok**. Bridge also writes under `workspace/.storage/logs/`.

---

## Security & privacy

- No multi-tenant SaaS; everything is local to your machine (plus whatever the Grok CLI calls with **your** credentials).  
- WS auth uses a secret stored in VS Code `SecretStorage`, shared only with the local bridge process.  
- Do not commit `.env`, `.storage/`, or Grok auth files.

---

## Credits

- Streaming bridge protocol, detach runtime, and chat UX patterns adapted from **[GrokifyOS](https://github.com/iBerry420/grokifyos)** (MIT).  
- Grok Build CLI / billing APIs are products of their respective owners; VSGrok only documents how to use your own accounts.

---

## Changelog

### 0.1.16

- **Install note:** reloading the window is not enough if the VSIX was never reinstalled — run `./scripts/install-local.sh` then **Developer: Reload Window**
- **User bubble always visible on send** — pending bubble lives outside webview `state` so host `fullState` cannot wipe it during the AI turn
- **Display only text after line-start `[User]:`** — matches bridge format; mid-line quotes of `"[User]: "` no longer truncate or leave system chrome
- Sanitize user rows on every state apply so wrapped Grok history never sticks in the UI

### 0.1.15

**Chat UX & durability**

- Instant user bubbles (optimistic + host transcript push)
- Clean user text (strip Grok system chrome for display)
- Local transcript mirror + merge with `~/.grok/sessions`
- Stream isolation (epoch / session filters)
- Mid-stream resume after IDE reload
- Atomic local session writes; unit tests for `displayUserText` / `mergeTranscripts`

### 0.1.14 and earlier

- Initial public release, app icon, streaming UX polish, hide Login when authenticated — see git history

---

## License

[MIT](LICENSE) © iBerry420
