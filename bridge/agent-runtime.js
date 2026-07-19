'use strict';

/**
 * Detached agent runtime — lets grok/cursor CLI processes outlive bridge restarts.
 *
 * Layout: {workspace}/.storage/bridge-runtime/{sessionId}/
 *   meta.json   — pid, model, offsets, partial msg id, etc.
 *   stdout.jsonl — agent stdout (one JSON event per line when possible)
 *   claim       — exclusive ownership (pid of owning bridge process)
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function createRuntime(opts) {
    const WORKSPACE = opts.workspace;
    const INSTANCE = opts.instanceId || 'a';
    const ROOT = path.join(WORKSPACE, '.storage', 'bridge-runtime');
    const log = typeof opts.log === 'function' ? opts.log : () => {};

    function ensureRoot() {
        if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
    }

    function sessionDir(sessionId) {
        return path.join(ROOT, sessionId);
    }

    function isPidAlive(pid) {
        if (!pid || typeof pid !== 'number') return false;
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    }

    function readJsonSafe(file, fallback = null) {
        try {
            return JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            return fallback;
        }
    }

    function writeJson(file, obj) {
        const tmp = file + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 0));
        fs.renameSync(tmp, file);
    }

    /**
     * Claim exclusive ownership of a session's agent runtime.
     * Stale claims (dead bridge pid) are stolen.
     */
    function tryClaim(sessionId) {
        ensureRoot();
        const dir = sessionDir(sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const claimPath = path.join(dir, 'claim');
        const payload = JSON.stringify({
            instance: INSTANCE,
            pid: process.pid,
            ts: Date.now(),
        });

        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                fs.writeFileSync(claimPath, payload, { flag: 'wx' });
                return true;
            } catch (err) {
                if (err.code !== 'EEXIST') throw err;
                const existing = readJsonSafe(claimPath);
                if (existing && existing.pid === process.pid) return true;
                if (existing && isPidAlive(existing.pid)) return false;
                // Stale claim — remove and retry
                try { fs.unlinkSync(claimPath); } catch (_) {}
            }
        }
        return false;
    }

    function releaseClaim(sessionId) {
        const claimPath = path.join(sessionDir(sessionId), 'claim');
        try {
            const existing = readJsonSafe(claimPath);
            if (existing && existing.pid === process.pid) {
                fs.unlinkSync(claimPath);
            }
        } catch (_) {}
    }

    function metaPath(sessionId) {
        return path.join(sessionDir(sessionId), 'meta.json');
    }

    function stdoutPath(sessionId) {
        return path.join(sessionDir(sessionId), 'stdout.jsonl');
    }

    function writeMeta(agent) {
        if (!agent?.sessionId) return;
        const meta = {
            sessionId: agent.sessionId,
            userId: agent.userId || null,
            pid: agent.pid || null,
            model: agent.model || null,
            provider: agent.provider || null,
            startTime: agent.startTime || Date.now(),
            partialMsgId: agent._partialMsgId || null,
            fileOffset: agent._fileOffset || 0,
            done: !!agent.done,
            instance: INSTANCE,
            updatedAt: Date.now(),
        };
        try {
            ensureRoot();
            const dir = sessionDir(agent.sessionId);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            writeJson(metaPath(agent.sessionId), meta);
        } catch (err) {
            log('warning', 'error', `meta write failed: ${err.message}`, {
                session_id: agent.sessionId?.substring(0, 8),
            });
        }
    }

    function readMeta(sessionId) {
        return readJsonSafe(metaPath(sessionId));
    }

    /**
     * Spawn agent detached with stdout/stderr redirected to a file.
     * Child outlives the bridge when systemd uses KillMode=process.
     */
    function spawnDetached(bin, args, env, sessionId, { truncate = true } = {}) {
        ensureRoot();
        const dir = sessionDir(sessionId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const out = stdoutPath(sessionId);
        if (truncate) {
            fs.writeFileSync(out, '');
        }
        const fd = fs.openSync(out, 'a');
        let proc;
        try {
            proc = spawn(bin, args, {
                cwd: WORKSPACE,
                stdio: ['ignore', fd, fd],
                detached: true,
                env: { ...env, HOME: env.HOME || process.env.HOME || '/root' },
            });
        } finally {
            try { fs.closeSync(fd); } catch (_) {}
        }
        // Do not unref immediately — we still want 'close' if the handle stays.
        // Detached + KillMode=process is what keeps the child alive across restart.
        return { proc, outPath: out, pid: proc.pid };
    }

    /**
     * Poll stdout file and invoke onLine for each complete line.
     * Also detects process exit via pid liveness.
     */
    function startFileTail(agent, {
        onLine,
        onExit,
        intervalMs = 80,
    }) {
        const outPath = agent.outPath || stdoutPath(agent.sessionId);
        let offset = agent._fileOffset || 0;
        let buffer = '';
        let stopped = false;

        const stop = () => {
            stopped = true;
            if (agent._tailTimer) {
                clearTimeout(agent._tailTimer);
                agent._tailTimer = null;
            }
        };
        agent._stopTail = stop;

        const tick = () => {
            if (stopped || agent.done) return;
            try {
                if (fs.existsSync(outPath)) {
                    const st = fs.statSync(outPath);
                    if (st.size > offset) {
                        const fd = fs.openSync(outPath, 'r');
                        const len = st.size - offset;
                        const buf = Buffer.alloc(len);
                        fs.readSync(fd, buf, 0, len, offset);
                        fs.closeSync(fd);
                        offset = st.size;
                        agent._fileOffset = offset;
                        buffer += buf.toString('utf8');
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed) continue;
                            try {
                                onLine(trimmed);
                            } catch (err) {
                                log('warning', 'error', `tail line error: ${err.message}`, {
                                    session_id: agent.sessionId?.substring(0, 8),
                                });
                            }
                        }
                        writeMeta(agent);
                    }
                }
            } catch (err) {
                log('warning', 'error', `tail read failed: ${err.message}`, {
                    session_id: agent.sessionId?.substring(0, 8),
                });
            }

            // Prefer ChildProcess close when available; also poll pid for recovered agents
            const alive = agent.proc
                ? !agent.proc.killed && agent.proc.exitCode === null && isPidAlive(agent.pid)
                : isPidAlive(agent.pid);

            if (!alive && !agent.done) {
                // Drain any remaining file content once more
                try {
                    if (fs.existsSync(outPath)) {
                        const st = fs.statSync(outPath);
                        if (st.size > offset) {
                            const fd = fs.openSync(outPath, 'r');
                            const len = st.size - offset;
                            const buf = Buffer.alloc(len);
                            fs.readSync(fd, buf, 0, len, offset);
                            fs.closeSync(fd);
                            offset = st.size;
                            agent._fileOffset = offset;
                            buffer += buf.toString('utf8');
                            for (const line of buffer.split('\n')) {
                                const trimmed = line.trim();
                                if (trimmed) {
                                    try { onLine(trimmed); } catch (_) {}
                                }
                            }
                            buffer = '';
                        }
                    }
                } catch (_) {}
                stop();
                try {
                    onExit(agent.proc?.exitCode ?? 0);
                } catch (_) {}
                return;
            }

            agent._tailTimer = setTimeout(tick, intervalMs);
        };

        // If we have a live ChildProcess, also hook close for faster exit detection
        if (agent.proc && typeof agent.proc.on === 'function') {
            agent.proc.on('close', (code) => {
                // Let the next tick drain + finalize
                agent._exitCode = code;
            });
            agent.proc.on('error', (err) => {
                log('error', 'error', `agent spawn error: ${err.message}`, {
                    session_id: agent.sessionId?.substring(0, 8),
                });
            });
        }

        tick();
        return stop;
    }

    /**
     * Replay existing stdout file into agent state (suppress network).
     */
    function rebuildFromStdout(agent, onLine) {
        const outPath = agent.outPath || stdoutPath(agent.sessionId);
        if (!fs.existsSync(outPath)) {
            agent._fileOffset = 0;
            return;
        }
        const raw = fs.readFileSync(outPath, 'utf8');
        agent._fileOffset = Buffer.byteLength(raw);
        for (const line of raw.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                onLine(trimmed);
            } catch (_) {}
        }
    }

    function listSessionDirs() {
        ensureRoot();
        try {
            return fs.readdirSync(ROOT).filter((name) => {
                try {
                    return fs.statSync(path.join(ROOT, name)).isDirectory()
                        && /^[a-f0-9]{32}$/.test(name);
                } catch {
                    return false;
                }
            });
        } catch {
            return [];
        }
    }

    /**
     * Remove runtime dirs for finished/dead agents older than maxAgeMs.
     */
    function cleanupStale(maxAgeMs = 2 * 60 * 60 * 1000) {
        const now = Date.now();
        for (const sid of listSessionDirs()) {
            const meta = readMeta(sid);
            if (!meta) continue;
            const alive = isPidAlive(meta.pid);
            if (alive) continue;
            const age = now - (meta.updatedAt || meta.startTime || 0);
            if (meta.done || age > maxAgeMs) {
                try {
                    fs.rmSync(sessionDir(sid), { recursive: true, force: true });
                } catch (_) {}
            }
        }
    }

    return {
        ROOT,
        INSTANCE,
        ensureRoot,
        sessionDir,
        isPidAlive,
        tryClaim,
        releaseClaim,
        writeMeta,
        readMeta,
        stdoutPath,
        spawnDetached,
        startFileTail,
        rebuildFromStdout,
        listSessionDirs,
        cleanupStale,
    };
}

module.exports = { createRuntime };
