import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { spawn, type ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { generateWsSecret, mintWsToken } from './WsAuth';

export type BridgeHealth = {
  status: string;
  port: number;
  agents?: number;
  instance?: string;
  grok_auth?: {
    ok?: boolean;
    email?: string | null;
    expired?: boolean;
    error?: string;
  };
};

export class BridgeManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private port = 0;
  private secret = '';
  private portFile = '';
  private output: vscode.OutputChannel;
  private starting: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    output: vscode.OutputChannel
  ) {
    super();
    this.output = output;
  }

  get isRunning(): boolean {
    return !!(this.proc && !this.proc.killed && this.port > 0);
  }

  get httpBase(): string {
    return this.port > 0 ? `http://127.0.0.1:${this.port}` : '';
  }

  get wsBase(): string {
    return this.port > 0 ? `ws://127.0.0.1:${this.port}/` : '';
  }

  async ensureSecret(): Promise<string> {
    const key = 'vsgrok.wsSecret';
    let secret = await this.context.secrets.get(key);
    if (!secret) {
      secret = generateWsSecret();
      await this.context.secrets.store(key, secret);
    }
    this.secret = secret;
    return secret;
  }

  mintToken(): string {
    if (!this.secret) {
      throw new Error('WS secret not ready');
    }
    return mintWsToken(this.secret);
  }

  async start(): Promise<void> {
    if (this.disposed) return;
    if (this.isRunning) return;
    if (this.starting) return this.starting;
    this.starting = this._start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async _start(): Promise<void> {
    await this.ensureSecret();
    const cfg = vscode.workspace.getConfiguration('vsgrok');
    const grokBin = cfg.get<string>('grokBin', 'grok');
    const reasoning = cfg.get<string>('reasoningEffort', 'high');
    const fixedPort = cfg.get<number>('bridgePort', 0);
    const dataDirName = cfg.get<string>('workspaceDataDir', '.vsgrok');

    const workspace =
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      this.context.globalStorageUri.fsPath;

    const runtimeRoot = path.join(workspace, dataDirName);
    fs.mkdirSync(runtimeRoot, { recursive: true });
    // Bridge expects hidden .storage/ under WORKSPACE
    const storageDir = path.join(workspace, '.storage');
    fs.mkdirSync(path.join(storageDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(storageDir, 'bridge-runtime'), { recursive: true });
    // One-time migrate legacy visible storage/ → .storage/
    migrateLegacyStorage(workspace, this.output);

    this.portFile = path.join(this.context.globalStorageUri.fsPath, 'bridge.port');
    fs.mkdirSync(path.dirname(this.portFile), { recursive: true });
    try {
      fs.unlinkSync(this.portFile);
    } catch {
      /* ignore */
    }

    const bridgeDir = path.join(this.context.extensionPath, 'bridge');
    const serverJs = path.join(bridgeDir, 'server.js');
    if (!fs.existsSync(serverJs)) {
      throw new Error(`Bridge server not found at ${serverJs}`);
    }

    // Ensure bridge deps installed once
    if (!fs.existsSync(path.join(bridgeDir, 'node_modules', 'ws'))) {
      this.output.appendLine('[bridge] installing npm dependencies…');
      await runNpmCi(bridgeDir, this.output);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      VSGROK_WORKSPACE: workspace,
      VSGROK_BRIDGE_PORT: String(fixedPort || 0),
      VSGROK_PORT_FILE: this.portFile,
      VSGROK_WS_AUTH_SECRET: this.secret,
      VSGROK_GROK_BIN: grokBin,
      VSGROK_REASONING_EFFORT: reasoning,
      VSGROK_BRIDGE_INSTANCE: 'vsgrok',
      VSGROK_BRIDGE_DETACH: '1',
      HOME: process.env.HOME || require('os').homedir(),
    };

    // Extension host process.execPath is Electron (code/cursor), NOT Node.
    // Always spawn a real Node binary for the bridge.
    const nodeBin = resolveNodeBinary(this.output);
    this.output.appendLine(`[bridge] starting with ${nodeBin} (workspace=${workspace})`);
    const child = spawn(nodeBin, [serverJs], {
      cwd: bridgeDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = child;

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      this.output.append(text);
      const m = text.match(/VSGROK_BRIDGE_READY port=(\d+)/);
      if (m) {
        this.port = parseInt(m[1], 10);
        this.emit('ready', this.port);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.output.append(chunk.toString());
    });
    child.on('exit', (code, signal) => {
      this.output.appendLine(`[bridge] exited code=${code} signal=${signal}`);
      this.proc = null;
      this.port = 0;
      this.emit('exit', code);
    });

    // Wait for port file or READY line
    const port = await waitForPort(this.portFile, 15000, () => this.port);
    this.port = port;
    this.output.appendLine(`[bridge] ready on :${port}`);
    this.emit('ready', port);
  }

  async stop(): Promise<void> {
    if (!this.proc) {
      this.port = 0;
      return;
    }
    const proc = this.proc;
    this.proc = null;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve();
      }, 3000);
      proc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
      try {
        proc.kill('SIGTERM');
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.port = 0;
  }

  async health(): Promise<BridgeHealth | null> {
    if (!this.port) return null;
    return httpGetJson<BridgeHealth>(`http://127.0.0.1:${this.port}/health`);
  }

  async models(): Promise<{
    grok_models: { id: string; name: string }[];
    default_model: string;
  } | null> {
    if (!this.port) return null;
    return httpGetJson(`http://127.0.0.1:${this.port}/models`);
  }

  async usage(force = false): Promise<Record<string, unknown> | null> {
    if (!this.port) return null;
    const q = force ? '?refresh=1' : '';
    return httpGetJson(`http://127.0.0.1:${this.port}/usage${q}`);
  }

  async startGrokLogin(force = false): Promise<Record<string, unknown> | null> {
    if (!this.port) return null;
    const q = force ? '?force=1' : '';
    return httpGetJson(`http://127.0.0.1:${this.port}/grok-login/start${q}`, 'POST');
  }

  async grokLoginStatus(): Promise<Record<string, unknown> | null> {
    if (!this.port) return null;
    return httpGetJson(`http://127.0.0.1:${this.port}/grok-login/status`);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }
}

function waitForPort(
  portFile: string,
  timeoutMs: number,
  getMemoryPort: () => number
): Promise<number> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const mem = getMemoryPort();
      if (mem > 0) {
        resolve(mem);
        return;
      }
      try {
        if (fs.existsSync(portFile)) {
          const raw = fs.readFileSync(portFile, 'utf8').trim();
          const p = parseInt(raw, 10);
          if (p > 0) {
            resolve(p);
            return;
          }
        }
      } catch {
        /* ignore */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Bridge did not become ready in time'));
        return;
      }
      setTimeout(tick, 100);
    };
    tick();
  });
}

function httpGetJson<T>(url: string, method: 'GET' | 'POST' = 'GET'): Promise<T | null> {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        timeout: 8000,
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body) as T);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function runNpmCi(dir: string, output: vscode.OutputChannel): Promise<void> {
  return new Promise((resolve, reject) => {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = fs.existsSync(path.join(dir, 'package-lock.json'))
      ? ['ci', '--omit=dev']
      : ['install', '--omit=dev'];
    const p = spawn(npm, args, {
      cwd: dir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    p.stdout?.on('data', (c) => output.append(c.toString()));
    p.stderr?.on('data', (c) => output.append(c.toString()));
    p.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`npm install failed with code ${code}`));
    });
  });
}

/**
 * Resolve a Node.js binary. VS Code/Cursor extension hosts set process.execPath
 * to Electron — using that to run bridge/server.js silently fails.
 */
function resolveNodeBinary(output: vscode.OutputChannel): string {
  const candidates: string[] = [];
  if (process.env.VSGROK_NODE) candidates.push(process.env.VSGROK_NODE);
  // Only trust execPath if it actually looks like node
  const exec = process.execPath || '';
  if (/(^|[/\\])node(\.exe)?$/i.test(exec)) candidates.push(exec);
  candidates.push('node');
  // Common install locations
  candidates.push(
    path.join(osHomedir(), '.nvm', 'current', 'bin', 'node'),
    '/usr/local/bin/node',
    '/usr/bin/node',
    path.join(osHomedir(), '.local', 'bin', 'node')
  );

  for (const c of candidates) {
    try {
      if (c === 'node') {
        // rely on PATH
        return c;
      }
      if (fs.existsSync(c)) {
        output.appendLine(`[bridge] using node: ${c}`);
        return c;
      }
    } catch {
      /* continue */
    }
  }
  output.appendLine('[bridge] falling back to PATH node');
  return 'node';
}

function osHomedir(): string {
  try {
    return require('os').homedir();
  } catch {
    return process.env.HOME || '/tmp';
  }
}

/** Move workspace/storage → workspace/.storage if the new path is empty. */
function migrateLegacyStorage(workspace: string, output: vscode.OutputChannel): void {
  const legacy = path.join(workspace, 'storage');
  const next = path.join(workspace, '.storage');
  try {
    if (!fs.existsSync(legacy) || !fs.statSync(legacy).isDirectory()) return;
    if (!fs.existsSync(next)) {
      fs.renameSync(legacy, next);
      output.appendLine('[bridge] migrated storage/ → .storage/');
      return;
    }
    // Merge shallow contents if .storage already exists
    for (const name of fs.readdirSync(legacy)) {
      const src = path.join(legacy, name);
      const dest = path.join(next, name);
      if (fs.existsSync(dest)) continue;
      try {
        fs.renameSync(src, dest);
      } catch {
        /* ignore busy files */
      }
    }
    // Remove legacy dir if empty
    try {
      if (fs.readdirSync(legacy).length === 0) fs.rmdirSync(legacy);
    } catch {
      /* ignore */
    }
    output.appendLine('[bridge] merged legacy storage/ into .storage/');
  } catch (err) {
    output.appendLine(
      `[bridge] storage migrate skipped: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
