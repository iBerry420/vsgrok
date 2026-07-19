'use strict';

/**
 * Imagine / Grok Build media harvest.
 *
 * Grok saves generated assets under:
 *   ~/.grok/sessions/{encoded-cwd}/{cli-session-id}/images|videos/
 * Tool results often only expose local paths (or short-lived CDN URLs). We copy
 * them into durable web-served storage and emit timeline media events.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const MEDIA_EXTS = new Set([...IMAGE_EXTS, ...VIDEO_EXTS]);

const IMAGINE_TOOLS = new Set([
    'image_gen',
    'image_edit',
    'image_to_video',
    'reference_to_video',
]);

function createMediaIngest({ workspace, log }) {
    const HOME = process.env.HOME || '/root';
    const UPLOAD_ROOT = path.join(workspace, 'uploads', 'system-chat');

    function grokProjectSessionRoot() {
        // Grok stores sessions under path with / → %2F (not full encodeURIComponent)
        const encoded = String(workspace).replace(/\//g, '%2F');
        return path.join(HOME, '.grok', 'sessions', encoded);
    }

    function ensureUploadDir(sessionId) {
        const dir = path.join(UPLOAD_ROOT, sessionId);
        if (!fs.existsSync(UPLOAD_ROOT)) {
            fs.mkdirSync(UPLOAD_ROOT, { recursive: true, mode: 0o775 });
            try {
                fs.chownSync(UPLOAD_ROOT, 33, 33); // www-data when running as root
            } catch (_) {}
        }
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o775 });
            try {
                fs.chownSync(dir, 33, 33);
            } catch (_) {}
        }
        return dir;
    }

    function kindFromPath(filePath) {
        const ext = path.extname(filePath || '').toLowerCase();
        if (VIDEO_EXTS.has(ext)) return 'video';
        if (IMAGE_EXTS.has(ext)) return 'image';
        if (String(filePath).includes('/videos/')) return 'video';
        if (String(filePath).includes('/images/')) return 'image';
        return null;
    }

    function isMediaPath(p) {
        if (!p || typeof p !== 'string') return false;
        const ext = path.extname(p).toLowerCase();
        return MEDIA_EXTS.has(ext);
    }

    function publicUrl(sessionId, fileName) {
        return `/uploads/system-chat/${sessionId}/${fileName}`;
    }

    function safeCopyLocal(srcAbs, destAbs) {
        fs.copyFileSync(srcAbs, destAbs);
        try {
            fs.chmodSync(destAbs, 0o644);
            fs.chownSync(destAbs, 33, 33);
        } catch (_) {}
    }

    function downloadUrl(url, destAbs, timeoutMs = 120000) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const finish = (err, res) => {
                if (settled) return;
                settled = true;
                if (err) reject(err);
                else resolve(res);
            };
            let parsed;
            try {
                parsed = new URL(url);
            } catch (e) {
                return finish(e);
            }
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return finish(new Error('unsupported protocol'));
            }
            const mod = parsed.protocol === 'https:' ? https : http;
            const req = mod.get(
                url,
                {
                    timeout: timeoutMs,
                    headers: {
                        'User-Agent': 'Grokpot-Bridge/1.0',
                        Accept: 'image/*,video/*,*/*',
                    },
                },
                (res) => {
                    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                        res.resume();
                        downloadUrl(res.headers.location, destAbs, timeoutMs).then(
                            (r) => finish(null, r),
                            finish
                        );
                        return;
                    }
                    if (res.statusCode !== 200) {
                        res.resume();
                        return finish(new Error(`HTTP ${res.statusCode}`));
                    }
                    const tmp = destAbs + '.part';
                    const out = fs.createWriteStream(tmp);
                    res.pipe(out);
                    out.on('finish', () => {
                        try {
                            fs.renameSync(tmp, destAbs);
                            try {
                                fs.chmodSync(destAbs, 0o644);
                                fs.chownSync(destAbs, 33, 33);
                            } catch (_) {}
                            finish(null, destAbs);
                        } catch (e) {
                            finish(e);
                        }
                    });
                    out.on('error', finish);
                }
            );
            req.on('error', finish);
            req.on('timeout', () => {
                req.destroy();
                finish(new Error('download timeout'));
            });
        });
    }

    function listRecentGrokSessions(afterMs) {
        const root = grokProjectSessionRoot();
        if (!fs.existsSync(root)) return [];
        let entries = [];
        try {
            entries = fs.readdirSync(root, { withFileTypes: true });
        } catch {
            return [];
        }
        const out = [];
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            // UUID-like session folders
            if (!/^[0-9a-f-]{20,}$/i.test(ent.name)) continue;
            const full = path.join(root, ent.name);
            let st;
            try {
                st = fs.statSync(full);
            } catch {
                continue;
            }
            // allow small clock skew / pre-create
            if (afterMs && st.mtimeMs + 5000 < afterMs) continue;
            out.push({ id: ent.name, path: full, mtimeMs: st.mtimeMs });
        }
        out.sort((a, b) => b.mtimeMs - a.mtimeMs);
        return out;
    }

    function resolveGrokSessionDir(agent) {
        if (agent._grokSessionDir && fs.existsSync(agent._grokSessionDir)) {
            return agent._grokSessionDir;
        }
        if (agent._grokCliSessionId) {
            const p = path.join(grokProjectSessionRoot(), agent._grokCliSessionId);
            if (fs.existsSync(p)) {
                agent._grokSessionDir = p;
                return p;
            }
        }
        const recent = listRecentGrokSessions(agent.startTime || Date.now());
        if (recent.length) {
            agent._grokSessionDir = recent[0].path;
            agent._grokCliSessionId = recent[0].id;
            return agent._grokSessionDir;
        }
        return null;
    }

    function initAgentMedia(agent) {
        if (!agent._mediaIngested) agent._mediaIngested = new Set();
        if (!agent.media) agent.media = [];
        if (!agent._mediaBySource) agent._mediaBySource = new Map();
        if (!agent._grokUpdateOffset) agent._grokUpdateOffset = 0;
        if (!agent._seenToolCallIds) agent._seenToolCallIds = new Set();
    }

    function emitMedia(agent, media, sendToClient) {
        const evt = {
            type: 'media',
            kind: media.kind,
            url: media.url,
            name: media.name,
            tool: media.tool || null,
            source: media.source || null,
        };
        agent.events.push(evt);
        // Insert into timeline after last tool segment when possible
        sendToClient(agent, evt);
    }

    function emitToolStart(agent, tool, detail, sendToClient, processHelpers) {
        // Prefer shared process path when available
        if (processHelpers && typeof processHelpers.onToolStart === 'function') {
            processHelpers.onToolStart(tool, detail);
            return;
        }
        agent.toolCount = (agent.toolCount || 0) + 1;
        const evt = {
            type: 'tool_start',
            tool,
            detail: String(detail || '').substring(0, 200),
            index: agent.toolCount,
        };
        if (!agent.toolEventLog) agent.toolEventLog = [];
        agent.toolEventLog.push({ tool, detail: evt.detail, success: null, info: '' });
        agent.events.push(evt);
        sendToClient(agent, evt);
    }

    function emitToolDone(agent, tool, success, info, sendToClient, processHelpers) {
        if (processHelpers && typeof processHelpers.onToolDone === 'function') {
            processHelpers.onToolDone(tool, success, info);
            return;
        }
        if (agent.toolEventLog && agent.toolEventLog.length) {
            const last = agent.toolEventLog[agent.toolEventLog.length - 1];
            if (last.tool === tool || last.success == null) {
                last.success = success;
                last.info = String(info || '').substring(0, 400);
            }
        }
        const evt = {
            type: 'tool_done',
            tool,
            success,
            info: String(info || '').substring(0, 400),
        };
        agent.events.push(evt);
        sendToClient(agent, evt);
    }

    /**
     * Persist a local file or remote URL into durable uploads.
     * @returns {object|null} media descriptor
     */
    function ingestSource(agent, source, opts = {}) {
        initAgentMedia(agent);
        if (!source || !agent.sessionId) return null;
        const key = String(source);
        if (agent._mediaIngested.has(key)) {
            return agent._mediaBySource.get(key) || null;
        }

        let kind = opts.kind || kindFromPath(source) || 'image';
        let ext = path.extname(source).toLowerCase();
        if (!MEDIA_EXTS.has(ext)) {
            ext = kind === 'video' ? '.mp4' : '.jpg';
        }

        const destDir = ensureUploadDir(agent.sessionId);
        const hash = crypto.createHash('sha256').update(key + Date.now()).digest('hex').slice(0, 20);
        const baseName = (opts.name || path.basename(source) || `media${ext}`)
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .slice(0, 80);
        const fileName = `${hash}_${baseName.endsWith(ext) ? baseName : baseName + ext}`;
        const destAbs = path.join(destDir, fileName);

        try {
            if (/^https?:\/\//i.test(source)) {
                // sync wait not ideal — caller may use ingestSourceAsync
                throw new Error('use_async_for_http');
            }
            // Local absolute path
            let abs = source;
            if (!path.isAbsolute(abs)) {
                // session-relative images/1.jpg
                const sess = resolveGrokSessionDir(agent);
                if (sess) abs = path.join(sess, source);
            }
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                return null;
            }
            // Prefer content hash for dedupe name
            const buf = fs.readFileSync(abs);
            const contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20);
            const stableName = `${contentHash}${ext}`;
            const stableAbs = path.join(destDir, stableName);
            if (!fs.existsSync(stableAbs)) {
                safeCopyLocal(abs, stableAbs);
            }
            kind = kindFromPath(abs) || kind;
            const url = publicUrl(agent.sessionId, stableName);
            const existing = agent.media.find((m) => m.url === url);
            if (existing) {
                agent._mediaIngested.add(key);
                agent._mediaBySource.set(key, existing);
                if (opts.tool && !existing.tool) existing.tool = opts.tool;
                return existing;
            }
            const media = {
                kind,
                url,
                name: path.basename(abs),
                tool: opts.tool || null,
                source: key,
                absPath: stableAbs,
            };
            agent._mediaIngested.add(key);
            agent._mediaBySource.set(key, media);
            // also mark content-hash
            agent._mediaIngested.add(stableAbs);
            agent.media.push(media);
            return media;
        } catch (err) {
            if (err && err.message === 'use_async_for_http') {
                return null;
            }
            if (typeof log === 'function') {
                log('warning', 'media', `Ingest failed: ${err.message}`, {
                    session_id: agent.sessionId?.substring(0, 8),
                    source: String(source).substring(0, 120),
                });
            }
            return null;
        }
    }

    async function ingestHttpUrl(agent, url, opts = {}) {
        initAgentMedia(agent);
        if (!url || !agent.sessionId) return null;
        const key = String(url);
        if (agent._mediaIngested.has(key)) {
            return agent._mediaBySource.get(key) || null;
        }
        let parsed;
        try {
            parsed = new URL(key);
        } catch (_) {
            // Agent text often contains pseudo-URLs (e.g. auth.json entry keys like
            // https://auth.x.ai::client-id). Skip those so harvest never crashes the worker.
            return null;
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
        let kind = opts.kind || kindFromPath(url) || 'image';
        let ext = path.extname(parsed.pathname).toLowerCase();
        if (!MEDIA_EXTS.has(ext)) ext = kind === 'video' ? '.mp4' : '.jpg';
        const destDir = ensureUploadDir(agent.sessionId);
        const tmpName = `dl_${crypto.randomBytes(8).toString('hex')}${ext}`;
        const tmpAbs = path.join(destDir, tmpName);
        try {
            await downloadUrl(url, tmpAbs);
            const buf = fs.readFileSync(tmpAbs);
            const contentHash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 20);
            const stableName = `${contentHash}${ext}`;
            const stableAbs = path.join(destDir, stableName);
            if (stableAbs !== tmpAbs) {
                if (!fs.existsSync(stableAbs)) fs.renameSync(tmpAbs, stableAbs);
                else fs.unlinkSync(tmpAbs);
            }
            kind = kindFromPath(stableName) || kind;
            const media = {
                kind,
                url: publicUrl(agent.sessionId, stableName),
                name: opts.name || path.basename(parsed.pathname) || stableName,
                tool: opts.tool || null,
                source: key,
                absPath: stableAbs,
            };
            agent._mediaIngested.add(key);
            agent._mediaBySource.set(key, media);
            agent.media.push(media);
            return media;
        } catch (err) {
            try {
                if (fs.existsSync(tmpAbs)) fs.unlinkSync(tmpAbs);
            } catch (_) {}
            if (typeof log === 'function') {
                log('warning', 'media', `URL download failed: ${err.message}`, {
                    session_id: agent.sessionId?.substring(0, 8),
                    url: String(url).substring(0, 160),
                });
            }
            return null;
        }
    }

    function scanSessionMediaDirs(agent, sendToClient) {
        const sess = resolveGrokSessionDir(agent);
        if (!sess) return;
        for (const folder of ['images', 'videos']) {
            const dir = path.join(sess, folder);
            if (!fs.existsSync(dir)) continue;
            let files = [];
            try {
                files = fs.readdirSync(dir);
            } catch {
                continue;
            }
            for (const f of files) {
                const abs = path.join(dir, f);
                try {
                    if (!fs.statSync(abs).isFile()) continue;
                } catch {
                    continue;
                }
                if (!isMediaPath(abs)) continue;
                const media = ingestSource(agent, abs, {
                    kind: folder === 'videos' ? 'video' : 'image',
                    name: f,
                    tool: folder === 'videos' ? 'image_to_video' : 'image_gen',
                });
                if (media && !media._emitted) {
                    media._emitted = true;
                    emitMedia(agent, media, sendToClient);
                }
            }
        }
    }

    function extractPathsFromText(text) {
        if (!text) return [];
        const s = String(text);
        const found = [];
        // absolute session paths
        const absRe =
            /\/root\/\.grok\/sessions\/[^\s"'\\]+\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov)/gi;
        let m;
        while ((m = absRe.exec(s))) found.push(m[0]);
        // short relative
        const relRe = /\b((?:images|videos)\/[0-9a-zA-Z._-]+\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov))\b/gi;
        while ((m = relRe.exec(s))) found.push(m[1]);
        // http(s) media-ish
        const urlRe =
            /https?:\/\/[^\s"'<>]+\.(?:jpg|jpeg|png|webp|gif|mp4|webm|mov)(?:\?[^\s"'<>]*)?/gi;
        while ((m = urlRe.exec(s))) found.push(m[0]);
        // generic temp CDN without extension (x.ai / assets)
        const tempRe =
            /https?:\/\/(?:[a-z0-9.-]+\.)?(?:x\.ai|grok\.com|imagine)[^\s"'<>]+/gi;
        while ((m = tempRe.exec(s))) {
            if (!found.includes(m[0])) found.push(m[0]);
        }
        return found;
    }

    function parseToolResultPayload(raw) {
        if (raw == null) return null;
        if (typeof raw === 'object') return raw;
        const s = String(raw).trim();
        if (!s) return null;
        try {
            return JSON.parse(s);
        } catch {
            return { path: s };
        }
    }

    function handleToolPayload(agent, toolName, payload, sendToClient, processHelpers) {
        const data = parseToolResultPayload(payload);
        if (!data) return;
        const candidates = [];
        if (data.path) candidates.push(data.path);
        if (data.url) candidates.push(data.url);
        if (data.media_url) candidates.push(data.media_url);
        if (data.filename && data.session_folder) {
            const sess = resolveGrokSessionDir(agent);
            if (sess) candidates.push(path.join(sess, data.session_folder, data.filename));
        }
        if (Array.isArray(data.images)) {
            for (const im of data.images) {
                if (typeof im === 'string') candidates.push(im);
                else if (im && im.path) candidates.push(im.path);
                else if (im && im.url) candidates.push(im.url);
            }
        }
        for (const c of candidates) {
            if (!c) continue;
            if (/^https?:\/\//i.test(c)) {
                // fire and forget async
                ingestHttpUrl(agent, c, { tool: toolName }).then((media) => {
                    if (media && !media._emitted) {
                        media._emitted = true;
                        emitMedia(agent, media, sendToClient);
                    }
                });
            } else {
                const media = ingestSource(agent, c, {
                    tool: toolName,
                    kind: toolName && toolName.includes('video') ? 'video' : undefined,
                });
                if (media && !media._emitted) {
                    media._emitted = true;
                    emitMedia(agent, media, sendToClient);
                }
            }
        }
    }

    /**
     * Parse Grok updates.jsonl for tool_call / tool_call_update (Imagine tools).
     * streaming-json often omits these; the on-disk session stream still has them.
     */
    function pollUpdatesJsonl(agent, sendToClient, processHelpers) {
        const sess = resolveGrokSessionDir(agent);
        if (!sess) return;
        const updatesPath = path.join(sess, 'updates.jsonl');
        if (!fs.existsSync(updatesPath)) return;
        let st;
        try {
            st = fs.statSync(updatesPath);
        } catch {
            return;
        }
        if (st.size <= (agent._grokUpdateOffset || 0)) return;

        let fd;
        try {
            fd = fs.openSync(updatesPath, 'r');
            const len = st.size - agent._grokUpdateOffset;
            if (len <= 0 || len > 8 * 1024 * 1024) {
                // skip huge jumps — seek to last 256k
                agent._grokUpdateOffset = Math.max(0, st.size - 256 * 1024);
            }
            const buf = Buffer.alloc(Math.min(st.size - agent._grokUpdateOffset, 1024 * 1024));
            const read = fs.readSync(fd, buf, 0, buf.length, agent._grokUpdateOffset);
            const chunk = buf.slice(0, read).toString('utf8');
            const lines = chunk.split('\n');
            // if incomplete last line, don't advance past it
            const complete = chunk.endsWith('\n') ? lines : lines.slice(0, -1);
            let advanced = 0;
            for (const line of complete) {
                advanced += Buffer.byteLength(line, 'utf8') + 1;
                const trimmed = line.trim();
                if (!trimmed) continue;
                let obj;
                try {
                    obj = JSON.parse(trimmed);
                } catch {
                    continue;
                }
                const update = obj?.params?.update || obj?.update || {};
                const su = update.sessionUpdate;
                if (su === 'tool_call') {
                    const tool =
                        update._meta?.['x.ai/tool']?.name ||
                        update.title ||
                        'tool';
                    const id = update.toolCallId || tool;
                    if (agent._seenToolCallIds.has(id + ':start')) continue;
                    agent._seenToolCallIds.add(id + ':start');
                    const detail = update.rawInput
                        ? JSON.stringify(update.rawInput).substring(0, 200)
                        : '';
                    // Only surface Imagine tools as first-class; still useful for others
                    emitToolStart(agent, tool, detail, sendToClient, processHelpers);
                } else if (su === 'tool_call_update' && update.status === 'completed') {
                    const tool =
                        update._meta?.['x.ai/tool']?.name ||
                        (typeof update.title === 'string' && !update.title.includes(':')
                            ? update.title
                            : null) ||
                        (agent.toolEventLog?.length
                            ? agent.toolEventLog[agent.toolEventLog.length - 1].tool
                            : null) ||
                        'tool';
                    const id = update.toolCallId || tool;
                    if (agent._seenToolCallIds.has(id + ':done')) continue;
                    agent._seenToolCallIds.add(id + ':done');
                    const rawOut = update.rawOutput || null;
                    let info = '';
                    if (rawOut && rawOut.path) info = String(rawOut.path);
                    else if (Array.isArray(update.content)) {
                        try {
                            const t = update.content[0]?.content?.text;
                            if (t) info = String(t).substring(0, 200);
                        } catch (_) {}
                    }
                    emitToolDone(agent, tool, true, info, sendToClient, processHelpers);
                    if (rawOut) {
                        handleToolPayload(agent, tool, rawOut, sendToClient, processHelpers);
                    } else if (info) {
                        handleToolPayload(agent, tool, info, sendToClient, processHelpers);
                    }
                }
            }
            agent._grokUpdateOffset += advanced;
        } catch (err) {
            if (typeof log === 'function') {
                log('debug', 'media', `updates poll: ${err.message}`, {
                    session_id: agent.sessionId?.substring(0, 8),
                });
            }
        } finally {
            if (fd != null) {
                try {
                    fs.closeSync(fd);
                } catch (_) {}
            }
        }
    }

    function harvestFromOutputText(agent, sendToClient) {
        const text = agent.fullOutput || '';
        const paths = extractPathsFromText(text);
        // also tool log info
        if (agent.toolEventLog) {
            for (const t of agent.toolEventLog) {
                if (t.info) paths.push(...extractPathsFromText(t.info));
                if (t.detail) paths.push(...extractPathsFromText(t.detail));
            }
        }
        for (const p of paths) {
            if (/^https?:\/\//i.test(p)) {
                ingestHttpUrl(agent, p).then((media) => {
                    if (media && !media._emitted) {
                        media._emitted = true;
                        emitMedia(agent, media, sendToClient);
                    }
                });
            } else {
                const media = ingestSource(agent, p);
                if (media && !media._emitted) {
                    media._emitted = true;
                    emitMedia(agent, media, sendToClient);
                }
            }
        }
    }

    /**
     * Rewrite assistant text so short/local paths become durable markdown media.
     */
    function rewriteOutputWithMedia(agent) {
        if (!agent || !agent.media || !agent.media.length) return agent.fullOutput || '';
        let text = agent.fullOutput || '';
        // Map sources → urls
        for (const m of agent.media) {
            if (!m || !m.url) continue;
            if (m.source && m.source !== m.url) {
                // escape regex
                const esc = m.source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                text = text.replace(new RegExp(esc, 'g'), m.url);
            }
            if (m.name) {
                const relImg = new RegExp(`\\bimages\\/${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
                const relVid = new RegExp(`\\bvideos\\/${m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
                const embed =
                    m.kind === 'video'
                        ? `\n\n[Video](${m.url})\n\n`
                        : `\n\n![${m.name}](${m.url})\n\n`;
                text = text.replace(relImg, embed.trim());
                text = text.replace(relVid, embed.trim());
            }
            // bare durable url → ensure markdown image once
            if (m.kind === 'image' && text.includes(m.url) && !text.includes(`](${m.url})`)) {
                text = text.replace(m.url, `![${m.name || 'image'}](${m.url})`);
            }
        }
        agent.fullOutput = text;
        return text;
    }

    function poll(agent, sendToClient, processHelpers) {
        if (!agent || agent.done) return;
        initAgentMedia(agent);
        resolveGrokSessionDir(agent);
        pollUpdatesJsonl(agent, sendToClient, processHelpers);
        scanSessionMediaDirs(agent, sendToClient);
        harvestFromOutputText(agent, sendToClient);
    }

    function startWatcher(agent, sendToClient, processHelpers) {
        initAgentMedia(agent);
        stopWatcher(agent);
        agent._mediaWatchTimer = setInterval(() => {
            try {
                poll(agent, sendToClient, processHelpers);
            } catch (err) {
                if (typeof log === 'function') {
                    log('debug', 'media', `watch poll error: ${err.message}`, {
                        session_id: agent.sessionId?.substring(0, 8),
                    });
                }
            }
        }, 1200);
        // immediate first tick shortly after spawn
        setTimeout(() => {
            try {
                poll(agent, sendToClient, processHelpers);
            } catch (_) {}
        }, 400);
    }

    function stopWatcher(agent) {
        if (agent && agent._mediaWatchTimer) {
            clearInterval(agent._mediaWatchTimer);
            agent._mediaWatchTimer = null;
        }
    }

    /**
     * Final harvest before persisting the assistant message.
     */
    function finalize(agent, sendToClient, processHelpers) {
        stopWatcher(agent);
        initAgentMedia(agent);
        resolveGrokSessionDir(agent);
        // re-read entire updates from 0 if we never found session mid-stream
        if (agent._grokSessionDir && agent._grokUpdateOffset === 0) {
            pollUpdatesJsonl(agent, sendToClient, processHelpers);
        } else {
            pollUpdatesJsonl(agent, sendToClient, processHelpers);
        }
        scanSessionMediaDirs(agent, sendToClient);
        harvestFromOutputText(agent, sendToClient);
        rewriteOutputWithMedia(agent);
        return agent.media || [];
    }

    function mediaForMetadata(agent) {
        if (!agent?.media?.length) return null;
        return agent.media.map((m) => ({
            kind: m.kind,
            url: m.url,
            name: m.name,
            tool: m.tool || null,
        }));
    }

    return {
        IMAGINE_TOOLS,
        startWatcher,
        stopWatcher,
        finalize,
        poll,
        ingestSource,
        ingestHttpUrl,
        rewriteOutputWithMedia,
        mediaForMetadata,
        extractPathsFromText,
        kindFromPath,
        isMediaPath,
    };
}

module.exports = { createMediaIngest };
