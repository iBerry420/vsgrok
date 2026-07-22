/* global acquireVsCodeApi */
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let state = {
    sessions: [],
    messages: [],
    models: [],
    notes: [],
    selectedModel: 'gb:grok-4.5',
    reasoningEffort: 'high',
    sessionId: null,
    sessionTitle: 'New Chat',
    bridgeConnected: false,
    bridgeRunning: false,
    streaming: false,
    stream: null,
    showThinking: true,
    showTools: true,
    enterToSend: false,
    useHistory: true,
    usage: null,
    health: null,
  };
  let lastAssistantMarkdown = '';
  let contextOn = true;
  /** When true, keep pin-to-bottom on new content. */
  let stickToBottom = true;
  /** User-closed collapsibles in the live stream (survive re-renders). */
  const streamUserClosed = new Set();
  /** Defer stream HTML rebuild while the user is selecting text. */
  let streamRenderPending = false;
  /**
   * Pending optimistic user bubble kept *outside* state so host fullState
   * overwrites cannot hide it until the AI turn ends / host confirms.
   * { id, role, content, createdAt } | null
   */
  let pendingUserBubble = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatElapsed(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    return s < 60 ? s + 's' : Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  }

  function formatUsagePercent(pct) {
    const n = Number(pct) || 0;
    return n % 1 === 0 ? String(n) : n.toFixed(1);
  }
  function formatUsagePercentLabel(pct) {
    return formatUsagePercent(pct) + '%';
  }
  function usageLevelClass(pct) {
    if (pct >= 90) return 'sc-usage-crit';
    if (pct >= 70) return 'sc-usage-warn';
    return '';
  }
  function usageProductName(raw) {
    const s = String(raw || '');
    if (/GrokBuild/i.test(s) || /build/i.test(s)) return 'Build';
    if (/GrokChat|Chat/i.test(s)) return 'Chat';
    if (/Imagine/i.test(s)) return 'Imagine';
    return s || 'Product';
  }
  function formatUsageReset(iso, short) {
    if (!iso) return '';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      const opts = short
        ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
        : { dateStyle: 'medium', timeStyle: 'short' };
      return 'Resets ' + d.toLocaleString(undefined, opts);
    } catch {
      return String(iso);
    }
  }

  /** Pretty-print JSON-looking strings. */
  function prettifyJson(s) {
    const t = String(s == null ? '' : s).trim();
    if (!t) return String(s == null ? '' : s);
    try {
      if (
        (t.startsWith('{') && t.endsWith('}')) ||
        (t.startsWith('[') && t.endsWith(']'))
      ) {
        return JSON.stringify(JSON.parse(t), null, 2);
      }
    } catch {
      /* not pure json */
    }
    // quoted JSON string
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      try {
        const inner = JSON.parse(t.startsWith("'") ? '"' + t.slice(1, -1).replace(/"/g, '\\"') + '"' : t);
        if (typeof inner === 'string') return prettifyJson(inner);
        return JSON.stringify(inner, null, 2);
      } catch {
        /* ignore */
      }
    }
    return String(s == null ? '' : s);
  }

  function renderDiffBody(body) {
    return String(body || '')
      .split('\n')
      .map((line) => {
        if (line.startsWith('+++') || line.startsWith('---')) {
          return '<span class="sc-diff-meta">' + esc(line) + '</span>';
        }
        if (line.startsWith('@@')) {
          return '<span class="sc-diff-hunk">' + esc(line) + '</span>';
        }
        if (line.startsWith('+')) {
          return '<span class="sc-diff-add">' + esc(line) + '</span>';
        }
        if (line.startsWith('-')) {
          return '<span class="sc-diff-del">' + esc(line) + '</span>';
        }
        return esc(line);
      })
      .join('\n');
  }

  function looksLikeUnifiedDiff(body) {
    const s = String(body || '');
    return (
      /^diff --git /m.test(s) ||
      /^@@ -\d/m.test(s) ||
      (/^[\+\-](?![\+\-]{2})/m.test(s) && /^[\+\-](?![\+\-]{2})/m.test(s.replace(/^[\+\-].*$/m, '')))
    );
  }

  function renderCodeFence(info, body) {
    const infoTrim = (info || '').trim();
    const lang = (infoTrim.split(/\s+/)[0] || 'text').toLowerCase();
    const pathHint = infoTrim.includes(' ')
      ? infoTrim.split(/\s+/).slice(1).join(' ')
      : /[:/]/.test(infoTrim) || /\.\w+$/.test(infoTrim)
        ? infoTrim
        : '';
    const isDiff =
      lang === 'diff' ||
      lang === 'patch' ||
      lang === 'udiff' ||
      looksLikeUnifiedDiff(body);
    let codeBody;
    const raw = body.replace(/\n$/, '');
    if (isDiff) codeBody = renderDiffBody(raw);
    else if (lang === 'json' || lang === 'jsonc') codeBody = esc(prettifyJson(raw));
    else codeBody = esc(prettifyJson(raw));
    return (
      '<div class="sc-code-block' +
      (isDiff ? ' sc-diff-block' : '') +
      '"><div class="sc-code-header"><span>' +
      esc(pathHint || lang) +
      '</span><span>' +
      (pathHint
        ? '<button type="button" data-apply-path="' + esc(pathHint) + '">Apply</button>'
        : '') +
      '<button type="button" data-copy="1">Copy</button></span></div><pre><code class="' +
      (isDiff ? 'sc-diff-code' : '') +
      '">' +
      codeBody +
      '</code></pre></div>'
    );
  }

  function inlineFormat(s) {
    let t = esc(s);
    // links [text](url)
    t = t.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" data-ext="1" class="sc-link">$1</a>'
    );
    // autolink bare URLs (avoid already-linked)
    t = t.replace(
      /(^|[\s(])(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
      '$1<a href="$2" data-ext="1" class="sc-link">$2</a>'
    );
    // bold / italic / code (order matters)
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
    t = t.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');
    t = t.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    return t;
  }

  /** Split a GFM table row into cells (leading/trailing pipes optional). */
  function splitTableRow(line) {
    let t = String(line).trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map((c) => c.trim());
  }

  /** True if line is a GFM table separator, e.g. | --- | :---: | ---: | */
  function isTableSeparator(line) {
    const trim = String(line || '').trim();
    if (!trim.includes('-') || !trim.includes('|')) return false;
    const cells = splitTableRow(trim);
    if (!cells.length) return false;
    return cells.every((c) => /^:?-{1,}:?$/.test(c));
  }

  /** Header + separator at lines[i] / lines[i+1] start a GFM table. */
  function isTableStart(lines, i) {
    if (i + 1 >= lines.length) return false;
    const head = (lines[i] || '').trim();
    if (!head.includes('|')) return false;
    if (/^\u0000BLOCK\d+\u0000$/.test(head)) return false;
    return isTableSeparator(lines[i + 1]);
  }

  function tableAlignFromSep(sepCells) {
    return sepCells.map((c) => {
      const s = c.trim();
      const left = s.startsWith(':');
      const right = s.endsWith(':');
      if (left && right) return 'center';
      if (right) return 'right';
      if (left) return 'left';
      return '';
    });
  }

  function renderTableCell(tag, text, align) {
    const style = align ? ' style="text-align:' + align + '"' : '';
    return '<' + tag + style + '>' + inlineFormat(text) + '</' + tag + '>';
  }

  function renderMarkdownTable(headerCells, aligns, bodyRows) {
    const colCount = Math.max(
      headerCells.length,
      aligns.length,
      ...bodyRows.map((r) => r.length),
      0
    );
    const pad = (cells) => {
      const out = cells.slice(0, colCount);
      while (out.length < colCount) out.push('');
      return out;
    };
    const head = pad(headerCells);
    const al = pad(aligns);
    let html =
      '<div class="sc-table-wrap"><table class="sc-table"><thead><tr>' +
      head.map((c, j) => renderTableCell('th', c, al[j])).join('') +
      '</tr></thead><tbody>';
    for (let r = 0; r < bodyRows.length; r++) {
      const row = pad(bodyRows[r]);
      html +=
        '<tr>' + row.map((c, j) => renderTableCell('td', c, al[j])).join('') + '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  /**
   * Extract fenced code blocks (``` / ~~~), including unclosed fences while streaming.
   * Replaces each fence with a \u0000BLOCKn\u0000 token and pushes HTML into blocks.
   */
  function extractCodeFences(text, blocks) {
    let result = '';
    let i = 0;
    const s = String(text);
    while (i < s.length) {
      const tick = s.indexOf('```', i);
      const wave = s.indexOf('~~~', i);
      let open = -1;
      let marker = '```';
      if (tick === -1 && wave === -1) {
        result += s.slice(i);
        break;
      }
      if (tick === -1 || (wave !== -1 && wave < tick)) {
        open = wave;
        marker = '~~~';
      } else {
        open = tick;
        marker = '```';
      }
      result += s.slice(i, open);
      const afterOpen = open + marker.length;
      const nl = s.indexOf('\n', afterOpen);
      let info;
      let bodyStart;
      if (nl === -1) {
        // Opening fence at EOF (still streaming info line)
        info = s.slice(afterOpen).replace(/\r$/, '');
        if (info.includes(marker[0]) && marker === '```') {
          // Not a real fence (e.g. inline ```)
          result += s.slice(open, afterOpen);
          i = afterOpen;
          continue;
        }
        const bi = blocks.length;
        blocks.push(renderCodeFence(info, ''));
        result += '\n\n\u0000BLOCK' + bi + '\u0000\n\n';
        break;
      }
      info = s.slice(afterOpen, nl);
      // Info line must not contain the fence marker char mid-token for ```
      if (marker === '```' && /`/.test(info)) {
        result += s.slice(open, afterOpen);
        i = afterOpen;
        continue;
      }
      bodyStart = nl + 1;
      const close = s.indexOf(marker, bodyStart);
      if (close === -1) {
        // Unclosed fence — rest of text is code (live thoughts/stream)
        const body = s.slice(bodyStart);
        const bi = blocks.length;
        blocks.push(renderCodeFence(info, body));
        result += '\n\n\u0000BLOCK' + bi + '\u0000\n\n';
        break;
      }
      const body = s.slice(bodyStart, close);
      const bi = blocks.length;
      blocks.push(renderCodeFence(info, body));
      result += '\n\n\u0000BLOCK' + bi + '\u0000\n\n';
      i = close + marker.length;
      if (s[i] === '\r') i++;
      if (s[i] === '\n') i++;
    }
    return result;
  }

  /**
   * Lightweight markdown: fences, headings, lists, tables, quotes, hr, paragraphs, links.
   * Used for assistant text and thinking blocks.
   */
  function renderMarkdown(src) {
    if (!src) return '';
    let text = String(src).replace(/\r\n/g, '\n');
    const blocks = [];
    text = extractCodeFences(text, blocks);

    const lines = text.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const trim = line.trim();

      if (!trim) {
        i++;
        continue;
      }

      // restored code block token
      const bm = trim.match(/^\u0000BLOCK(\d+)\u0000$/);
      if (bm) {
        out.push(blocks[Number(bm[1])] || '');
        i++;
        continue;
      }

      // headings
      const hm = trim.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        const level = hm[1].length;
        out.push('<h' + level + ' class="sc-h">' + inlineFormat(hm[2]) + '</h' + level + '>');
        i++;
        continue;
      }

      // hr
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trim)) {
        out.push('<hr class="sc-hr"/>');
        i++;
        continue;
      }

      // GFM table: header | sep | body rows
      if (isTableStart(lines, i)) {
        const headerCells = splitTableRow(lines[i]);
        const aligns = tableAlignFromSep(splitTableRow(lines[i + 1]));
        i += 2;
        const bodyRows = [];
        while (i < lines.length) {
          const rowTrim = (lines[i] || '').trim();
          if (!rowTrim) break;
          if (!rowTrim.includes('|')) break;
          if (/^\u0000BLOCK\d+\u0000$/.test(rowTrim)) break;
          if (/^(#{1,6})\s+/.test(rowTrim)) break;
          if (/^(-{3,}|\*{3,}|_{3,})$/.test(rowTrim)) break;
          if (isTableSeparator(rowTrim)) break;
          bodyRows.push(splitTableRow(lines[i]));
          i++;
        }
        out.push(renderMarkdownTable(headerCells, aligns, bodyRows));
        continue;
      }

      // blockquote
      if (/^>\s?/.test(trim)) {
        const q = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim() || '')) {
          q.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        out.push(
          '<blockquote class="sc-quote">' +
            q.map((l) => (l ? '<p>' + inlineFormat(l) + '</p>' : '')).join('') +
            '</blockquote>'
        );
        continue;
      }

      // unordered list (- * +)
      if (/^[-*+]\s+/.test(trim)) {
        const items = [];
        while (i < lines.length && /^[-*+]\s+/.test((lines[i] || '').trim())) {
          items.push((lines[i] || '').trim().replace(/^[-*+]\s+/, ''));
          i++;
        }
        out.push(
          '<ul class="sc-ul">' +
            items.map((it) => '<li>' + inlineFormat(it) + '</li>').join('') +
            '</ul>'
        );
        continue;
      }

      // ordered list
      if (/^\d+[.)]\s+/.test(trim)) {
        const items = [];
        while (i < lines.length && /^\d+[.)]\s+/.test((lines[i] || '').trim())) {
          items.push((lines[i] || '').trim().replace(/^\d+[.)]\s+/, ''));
          i++;
        }
        out.push(
          '<ol class="sc-ol">' +
            items.map((it) => '<li>' + inlineFormat(it) + '</li>').join('') +
            '</ol>'
        );
        continue;
      }

      // paragraph (consume until blank)
      const para = [];
      while (i < lines.length && lines[i].trim()) {
        const t = lines[i].trim();
        if (
          /^\u0000BLOCK\d+\u0000$/.test(t) ||
          /^(#{1,6})\s+/.test(t) ||
          /^[-*+]\s+/.test(t) ||
          /^\d+[.)]\s+/.test(t) ||
          /^>\s?/.test(t) ||
          /^(-{3,}|\*{3,}|_{3,})$/.test(t) ||
          isTableStart(lines, i)
        ) {
          break;
        }
        para.push(lines[i]);
        i++;
      }
      if (para.length) {
        out.push('<p>' + inlineFormat(para.join('\n')).replace(/\n/g, '<br/>') + '</p>');
      } else {
        i++;
      }
    }

    return out.join('');
  }

  function segKey(seg, index) {
    if (seg.type === 'tool') {
      return 'tool-' + index + '-' + (seg.tool || 'tool');
    }
    if (seg.type === 'thinking') return 'thinking-' + index;
    if (seg.type === 'media') return 'media-' + index + '-' + (seg.url || '');
    if (seg.type === 'text') return 'text-' + index;
    return 'seg-' + index;
  }

  function renderTimeline(timeline, opts) {
    const live = !!(opts && opts.live);
    let html = '';
    const list = timeline || [];
    for (let i = 0; i < list.length; i++) {
      const seg = list[i];
      const key = segKey(seg, i);
      if (seg.type === 'thinking' && state.showThinking) {
        const userClosed = live && streamUserClosed.has(key);
        // Live: open while thinking unless user closed; finished: closed unless user opened
        // (user open state tracked as NOT in streamUserClosed + was open — we only track closed)
        const defaultOpen = !seg.done;
        const open = !userClosed && defaultOpen ? ' open' : '';
        const label = seg.done ? 'Thoughts' : 'Thinking';
        html +=
          '<details class="sc-thinking-block" data-seg="' +
          esc(key) +
          '"' +
          open +
          '><summary><span class="sc-thinking-label">' +
          label +
          '</span></summary><div class="sc-thinking-body sc-md">' +
          renderMarkdown(seg.content || '') +
          '</div></details>';
      } else if (seg.type === 'tool' && state.showTools) {
        const done = seg.success != null;
        const ok = done && seg.success !== false;
        const cls =
          'sc-tool-card' + (done ? (ok ? ' ok' : ' fail') : ' running');
        const detail = prettifyJson(seg.detail || '');
        const info = prettifyJson(seg.info || '');
        const title =
          '⚙ ' +
          esc(seg.tool || 'tool') +
          (done ? (ok ? ' · ok' : ' · failed') : ' · running');
        const userClosed = live && streamUserClosed.has(key);
        const defaultOpen = !done;
        const open = !userClosed && defaultOpen ? ' open' : '';
        html +=
          '<details class="' +
          cls +
          '" data-seg="' +
          esc(key) +
          '"' +
          open +
          '><summary>' +
          title +
          '</summary><div class="sc-tool-body">';
        if (detail) {
          html +=
            '<div class="sc-tool-label">Input</div><pre class="sc-tool-pre">' +
            esc(detail) +
            '</pre>';
        }
        if (info) {
          html +=
            '<div class="sc-tool-label">Result</div><pre class="sc-tool-pre">' +
            esc(info) +
            '</pre>';
        }
        if (!detail && !info) {
          html += '<div class="sc-tool-empty">No payload</div>';
        }
        html += '</div></details>';
      } else if (seg.type === 'media' && seg.url) {
        html +=
          '<div class="sc-tool-card sc-media-card" data-seg="' +
          esc(key) +
          '">🖼 ' +
          esc(seg.name || seg.kind || 'media') +
          ' <a href="' +
          esc(seg.url) +
          '" data-ext="1" class="sc-link">open</a></div>';
      } else if (seg.type === 'text' && seg.content) {
        html +=
          '<div class="sc-md" data-seg="' +
          esc(key) +
          '">' +
          renderMarkdown(seg.content) +
          '</div>';
      }
    }
    return html;
  }

  function hasSelectionIn(root) {
    if (!root) return false;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    let node = sel.anchorNode;
    if (!node) return false;
    if (node.nodeType === 3) node = node.parentNode;
    return !!(node && root.contains(node));
  }

  function captureOpenSegs(root) {
    const open = new Set();
    if (!root) return open;
    root.querySelectorAll('details[data-seg][open]').forEach((d) => {
      open.add(d.getAttribute('data-seg'));
    });
    return open;
  }

  function restoreOpenSegs(root, openKeys) {
    if (!root || !openKeys) return;
    root.querySelectorAll('details[data-seg]').forEach((d) => {
      const k = d.getAttribute('data-seg');
      if (!k) return;
      // User explicitly closed → force closed
      if (streamUserClosed.has(k)) {
        d.removeAttribute('open');
        return;
      }
      // Restore previously open, or keep default from HTML
      if (openKeys.has(k)) d.setAttribute('open', '');
    });
  }

  function updateStreamMetaOnly() {
    const metaEl = document.querySelector('#stream .sc-msg-meta');
    if (!metaEl || !state.stream) return;
    const s = state.stream;
    metaEl.textContent =
      (s.model || '…') +
      ' · ' +
      formatElapsed(Date.now() - (s.startTime || Date.now()));
  }

  function toast(level, text) {
    const el = document.createElement('div');
    el.className = 'sc-toast ' + (level || 'info');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  function closePopovers() {
    document.querySelectorAll('.sc-wrap.open').forEach((w) => w.classList.remove('open'));
  }
  function toggleWrap(id) {
    const w = $(id);
    if (!w) return;
    const open = w.classList.contains('open');
    closePopovers();
    if (!open) w.classList.add('open');
  }

  function scrollEl() {
    return $('scroll');
  }

  function isNearBottom(el, px) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < (px || 48);
  }

  function maybeScrollToBottom(force) {
    const el = scrollEl();
    if (!el) return;
    if (force || stickToBottom) {
      el.scrollTop = el.scrollHeight;
    }
  }

  function renderUsage() {
    const chip = $('usageChip');
    const detail = $('usageDetail');
    const body = $('usageBody');
    const tierEl = $('usageTier');
    const data = state.usage;

    if (!data || data.ok === false) {
      if (chip) {
        chip.textContent = 'Usage —';
        chip.classList.remove('sc-usage-warn', 'sc-usage-crit');
        chip.title = (data && (data.message || data.error)) || 'Usage unavailable';
      }
      if (body) {
        body.innerHTML =
          '<div class="sc-usage-error">' +
          esc((data && (data.message || data.error)) || 'Sign in to Grok Build to load usage.') +
          '</div>';
      }
      if (detail) detail.classList.remove('sc-usage-warn', 'sc-usage-crit');
      return;
    }

    const pct = Number(data.usage_percent) || 0;
    const remaining = Number(data.remaining_percent);
    const rem = Number.isFinite(remaining) ? remaining : Math.max(0, 100 - pct);
    const level = usageLevelClass(pct);

    if (chip) {
      chip.textContent = formatUsagePercentLabel(pct) + ' used';
      chip.classList.toggle('sc-usage-warn', pct >= 70 && pct < 90);
      chip.classList.toggle('sc-usage-crit', pct >= 90);
      chip.title = formatUsagePercentLabel(rem) + ' left · tap to open settings';
    }

    if (tierEl) {
      const tier = data.subscription_tier;
      if (tier) {
        tierEl.hidden = false;
        tierEl.textContent = String(tier);
      } else {
        tierEl.hidden = true;
      }
    }

    if (detail) {
      detail.classList.toggle('sc-usage-warn', level === 'sc-usage-warn');
      detail.classList.toggle('sc-usage-crit', level === 'sc-usage-crit');
    }

    let productsHtml = '';
    const products = (data.products || []).filter(
      (p) => p.usage_percent != null && Number(p.usage_percent) > 0
    );
    if (products.length) {
      productsHtml =
        '<div class="sc-usage-products"><div class="sc-usage-products-label">By product</div>' +
        products
          .map((p) => {
            const pPct = Number(p.usage_percent) || 0;
            const pLevel = usageLevelClass(pPct);
            const w = Math.min(100, Math.max(0, pPct));
            return (
              '<div class="sc-usage-product ' +
              pLevel +
              '"><div class="sc-usage-product-row">' +
              '<span class="sc-usage-product-name">' +
              esc(usageProductName(p.product)) +
              '</span><span class="sc-usage-product-pct">' +
              esc(formatUsagePercentLabel(pPct)) +
              '</span></div><div class="sc-usage-product-bar"><span style="width:' +
              w +
              '%"></span></div></div>'
            );
          })
          .join('') +
        '</div>';
    }

    if (body) {
      body.innerHTML =
        '<div class="sc-usage-hero"><div class="sc-usage-hero-left">' +
        '<span class="sc-usage-pct">' +
        esc(formatUsagePercent(pct)) +
        '</span><span class="sc-usage-pct-unit">%</span>' +
        '<span class="sc-usage-pct-label">used</span></div>' +
        '<div class="sc-usage-left">' +
        esc(formatUsagePercentLabel(rem)) +
        ' left</div></div>' +
        '<div class="sc-usage-bar ' +
        level +
        '"><span style="width:' +
        Math.min(100, Math.max(0, pct)) +
        '%"></span></div>' +
        '<div class="sc-usage-reset">' +
        esc(formatUsageReset(data.reset_at, true)) +
        '</div>' +
        productsHtml;
    }
  }

  function iconCopy() {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
  }
  function iconHide(active) {
    return (
      '<button type="button" data-act="hide" title="' +
      (active ? 'Include in context' : 'Hide from context') +
      '" aria-label="Hide from context" class="' +
      (active ? 'active' : '') +
      '"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></button>'
    );
  }
  function iconDelete() {
    return '<button type="button" data-act="delete" title="Delete from chat" aria-label="Delete"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg></button>';
  }
  function iconCopyBtn() {
    return (
      '<button type="button" data-act="copy" title="Copy" aria-label="Copy">' +
      iconCopy() +
      '</button>'
    );
  }

  function actionsHtml(m) {
    const excluded = !!m.excludedFromContext;
    const hide = iconHide(excluded);
    // User: delete, hide, copy · AI: copy, hide, delete
    const buttons =
      m.role === 'user'
        ? iconDelete() + hide + iconCopyBtn()
        : iconCopyBtn() + hide + iconDelete();
    return (
      '<div class="sc-msg-actions" data-mid="' +
      esc(m.id) +
      '" role="toolbar">' +
      buttons +
      '</div>'
    );
  }

  /**
   * Client-side safety net: never render Grok system chrome as the user bubble.
   * Prefer text after the last *line-start* `[User]:` (bridge format).
   */
  function displayUserContent(raw) {
    let t = String(raw == null ? '' : raw).trim();
    if (!t) return '';

    // Line-anchored marker so mid-line quotes of "[User]:" do not truncate.
    const re = /(?:^|\n)\[User\]:\s*/gi;
    let last = null;
    let m;
    while ((m = re.exec(t)) !== null) last = m;
    if (last) {
      let out = t.slice(last.index + last[0].length).trim();
      out = out.replace(/<\/user_query>\s*$/i, '').trim();
      if (out) return out;
    }

    const q = t.match(/<user_query>\s*([\s\S]*?)\s*<\/user_query>/i);
    if (q) t = (q[1] || '').trim();
    const strip = [
      'user_info',
      'system-reminder',
      'additional_notes',
      'conversation_history',
      'agent_skills',
      'available_skills',
      'rules',
      'user_rules',
      'git_status',
    ];
    for (let i = 0; i < strip.length; i++) {
      const tag = strip[i];
      t = t.replace(new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]*?<\\/' + tag + '>', 'gi'), '');
    }
    t = t.replace(/<system-reminder\b[^>]*>[\s\S]*/gi, '');
    t = t.replace(/<user_info\b[^>]*>[\s\S]*/gi, '');
    t = t
      .replace(
        /^When you reply, write only your new answer\.\s*Do not repeat prior lines unless asked\.\s*/i,
        ''
      )
      .trim();
    return t.trim();
  }

  /** Normalize user messages in a list so system chrome never lives in state. */
  function sanitizeUserMessages(msgs) {
    if (!Array.isArray(msgs)) return msgs;
    return msgs
      .map((m) => {
        if (!m || m.role !== 'user') return m;
        const cleaned = displayUserContent(m.content || '');
        if (!cleaned) return null;
        if (cleaned === m.content) return m;
        return { ...m, content: cleaned };
      })
      .filter(Boolean);
  }

  function messagesForRender() {
    let msgs = sanitizeUserMessages(state.messages || []) || [];
    if (pendingUserBubble && pendingUserBubble.content) {
      const want = pendingUserBubble.content;
      const has = msgs.some(
        (m) =>
          m.role === 'user' &&
          (sameUserContent(m.content, want) ||
            sameUserContent(displayUserContent(m.content), want))
      );
      if (!has) {
        msgs = msgs.concat([
          {
            id: pendingUserBubble.id,
            role: 'user',
            content: pendingUserBubble.content,
            createdAt: pendingUserBubble.createdAt,
          },
        ]);
      } else {
        // Host has caught up — drop pending so we don't double up later
        pendingUserBubble = null;
      }
    }
    return msgs;
  }

  function messageHtml(m) {
    const meta = m.metadata || {};
    const excluded = !!m.excludedFromContext;
    const metaLine =
      m.role === 'assistant'
        ? esc(meta.model || '') + (meta.duration ? ' · ' + formatElapsed(meta.duration) : '')
        : '';
    let body;
    if (m.role === 'assistant' && meta.timeline && meta.timeline.length) {
      body = renderTimeline(meta.timeline);
    } else if (m.role === 'assistant') {
      body = '<div class="sc-md">' + renderMarkdown(m.content || '') + '</div>';
    } else {
      const userText = displayUserContent(m.content || '');
      body = '<div class="sc-md">' + renderMarkdown(userText) + '</div>';
    }
    if (m.role === 'assistant' && m.content) lastAssistantMarkdown = m.content;
    // Action bar is a sibling of the bubble so it can displace layout (not overlay)
    return (
      '<div class="sc-msg ' +
      esc(m.role) +
      (excluded ? ' excluded' : '') +
      '" data-mid="' +
      esc(m.id) +
      '">' +
      actionsHtml(m) +
      '<div class="sc-msg-bubble">' +
      (metaLine ? '<div class="sc-msg-meta">' + metaLine + '</div>' : '') +
      body +
      '</div></div>'
    );
  }

  function renderMessages() {
    const root = $('messages');
    if (!root) return;
    const msgs = messagesForRender();
    if (!msgs.length && !state.streaming && !pendingUserBubble) {
      root.innerHTML =
        '<div class="sc-welcome"><h3>VSGrok Chat</h3><p>Grok Build sessions for this workspace. History comes from <code>~/.grok/sessions</code>.</p></div>';
      return;
    }
    let html = '';
    for (const m of msgs) {
      // Hide empty streaming assistant stub — live content is in #stream
      if (m.metadata && m.metadata.streaming && state.streaming) continue;
      html += messageHtml(m);
    }
    root.innerHTML = html;
    maybeScrollToBottom(false);
  }

  function renderStream() {
    const el = $('stream');
    if (!el) return;
    if (!state.streaming || !state.stream) {
      el.innerHTML = '';
      streamUserClosed.clear();
      streamRenderPending = false;
      return;
    }

    // Don't blow away open details / text selection mid-interaction
    if (hasSelectionIn(el) || hasSelectionIn(scrollEl())) {
      streamRenderPending = true;
      updateStreamMetaOnly();
      return;
    }

    const prevOpen = captureOpenSegs(el);
    const sc = scrollEl();
    const prevScroll = sc ? sc.scrollTop : 0;

    const s = state.stream;
    const meta =
      esc(s.model || '…') +
      ' · ' +
      formatElapsed(Date.now() - (s.startTime || Date.now()));
    let body = renderTimeline(s.timeline || [], { live: true });
    if (!body && s.fullText) body = '<div class="sc-md">' + renderMarkdown(s.fullText) + '</div>';
    if (!body) body = '<div class="sc-md sc-muted-line">Thinking…</div>';
    el.innerHTML =
      '<div class="sc-msg assistant streaming" data-mid="__stream__">' +
      '<div class="sc-msg-bubble"><div class="sc-msg-meta">' +
      meta +
      '</div>' +
      body +
      '</div></div>';

    // Re-apply open state: previous opens + anything not user-closed
    restoreOpenSegs(el, prevOpen);
    // Also open keys that were open before and still exist
    el.querySelectorAll('details[data-seg]').forEach((d) => {
      const k = d.getAttribute('data-seg');
      if (k && prevOpen.has(k) && !streamUserClosed.has(k)) {
        d.setAttribute('open', '');
      }
    });

    if (s.fullText) lastAssistantMarkdown = s.fullText;
    streamRenderPending = false;

    if (stickToBottom) {
      maybeScrollToBottom(false);
    } else if (sc) {
      // Preserve scroll position so content growth doesn't jump selection target
      sc.scrollTop = prevScroll;
    }
  }

  function renderSessions() {
    const list = $('sessionList');
    if (!list) return;
    const sessions = state.sessions || [];
    list.innerHTML = sessions
      .map((s) => {
        const active = s.id === state.sessionId ? ' active' : '';
        return (
          '<button type="button" class="sc-session-item' +
          active +
          '" data-sid="' +
          esc(s.id) +
          '">' +
          esc(s.title || 'Chat') +
          '<span class="sc-session-meta">' +
          esc(String(s.id).slice(0, 8)) +
          (s.messageCount ? ' · ' + s.messageCount + ' msgs' : '') +
          '</span></button>'
        );
      })
      .join('') || '<div class="sc-session-meta" style="padding:8px">No sessions yet</div>';
  }

  function renderModels() {
    const sel = $('modelSelect');
    if (!sel) return;
    sel.innerHTML = (state.models || [])
      .map(
        (m) =>
          '<option value="' +
          esc(m.id) +
          '"' +
          (m.id === state.selectedModel ? ' selected' : '') +
          '>' +
          esc(m.name || m.id) +
          '</option>'
      )
      .join('');
  }

  function renderEffort() {
    const sel = $('effortSelect');
    if (!sel) return;
    const effort = state.reasoningEffort || 'high';
    const allowed = { low: 1, medium: 1, high: 1 };
    sel.value = allowed[effort] ? effort : 'high';
  }

  function renderNotes() {
    const list = $('notesList');
    const badge = $('notesBadge');
    const notes = state.notes || [];
    const enabled = notes.filter((n) => n.enabled !== false).length;
    if (badge) {
      if (enabled) {
        badge.classList.remove('hidden');
        badge.textContent = String(enabled);
      } else badge.classList.add('hidden');
    }
    if (!list) return;
    list.innerHTML = notes
      .map(
        (n, i) =>
          '<div class="sc-note-row"><input type="checkbox" data-note-i="' +
          i +
          '" ' +
          (n.enabled !== false ? 'checked' : '') +
          '/><span>' +
          esc(n.text) +
          '</span><button type="button" data-note-del="' +
          i +
          '">✕</button></div>'
      )
      .join('');
  }

  function renderStatus() {
    const dot = $('statusDot');
    if (dot) {
      dot.classList.remove('connected', 'busy');
      if (state.streaming) dot.classList.add('busy');
      else if (state.bridgeConnected) dot.classList.add('connected');
    }
    const warn = $('bridgeWarn');
    if (warn) {
      if (!state.bridgeRunning && !state.bridgeConnected) warn.classList.remove('hidden');
      else warn.classList.add('hidden');
    }
    const title = $('topbarTitle');
    if (title) title.textContent = state.sessionTitle || 'New Chat';

    const banner = $('loginBanner');
    const auth = state.health && state.health.grok_auth;
    const loggedIn = !!(auth && auth.ok === true && !auth.expired);
    // Settings "Login to Grok" only when not authenticated
    const btnLogin = $('btnLogin');
    if (btnLogin) {
      btnLogin.classList.toggle('hidden', loggedIn);
    }
    if (banner) {
      if (!loggedIn && auth && auth.ok === false) {
        banner.classList.remove('hidden');
        banner.innerHTML =
          'Grok not signed in. <button type="button" id="btnLoginBanner">Login</button>';
        const b = $('btnLoginBanner');
        if (b) b.onclick = () => vscode.postMessage({ type: 'loginGrok' });
      } else if (!loggedIn && !auth) {
        // health missing / unknown — show login in settings only, no banner spam
        banner.classList.add('hidden');
      } else {
        banner.classList.add('hidden');
      }
    }

    const root = document.getElementById('app');
    if (root) {
      root.classList.toggle('sc-hide-tools', !state.showTools);
      root.classList.toggle('sc-hide-thoughts', !state.showThinking);
    }

    const send = $('btnSend');
    const stop = $('btnStop');
    const prompt = $('prompt');
    if (send) {
      send.disabled = !!state.streaming || !(prompt && prompt.value.trim());
      send.classList.toggle('hidden', !!state.streaming);
    }
    if (stop) {
      stop.classList.toggle('hidden', !state.streaming);
    }

    const set = (id, v) => {
      const el = $(id);
      if (el) el.checked = !!v;
    };
    set('setHistory', state.useHistory);
    set('setEnterNewline', !state.enterToSend);
    set('setShowTools', state.showTools);
    set('setShowThoughts', state.showThinking);

    const ctx = $('btnContext');
    if (ctx) ctx.classList.toggle('active', contextOn);
  }

  function sameUserContent(a, b) {
    return (
      String(a || '')
        .replace(/\s+/g, ' ')
        .trim() ===
      String(b || '')
        .replace(/\s+/g, ' ')
        .trim()
    );
  }

  function applyState(payload) {
    const wasStreaming = state.streaming;
    let next = payload || {};
    // Always sanitize user rows so wrapped Grok history never lands in state.
    if (Array.isArray(next.messages)) {
      next = { ...next, messages: sanitizeUserMessages(next.messages) };
    }
    // Clear pending bubble once host has the same clean user text
    if (pendingUserBubble && Array.isArray(next.messages)) {
      const want = pendingUserBubble.content;
      const has = next.messages.some(
        (m) =>
          m.role === 'user' &&
          (sameUserContent(m.content, want) ||
            sameUserContent(displayUserContent(m.content), want))
      );
      if (has) pendingUserBubble = null;
    }
    // Host finished streaming without ever confirming — keep pending until next send
    if (next.streaming === false && wasStreaming && pendingUserBubble) {
      // leave pending; renderMessages will still show it
    }
    // Host null stream while not streaming must clear residual previous bubble.
    if (next.stream === null || next.stream === undefined) {
      if (!next.streaming) next = { ...next, stream: null };
    }
    state = { ...state, ...next };
    // Persist transcript in webview state so panel reloads keep messages
    // even if a host push is delayed (IDE webview recreate).
    try {
      vscode.setState({
        sessionId: state.sessionId,
        messages: state.messages,
        sessionTitle: state.sessionTitle,
      });
    } catch {
      /* ignore */
    }
    renderSessions();
    renderModels();
    renderEffort();
    renderNotes();
    renderMessages();
    renderStream();
    renderUsage();
    renderStatus();
    // After first paint of a new turn, stick to bottom
    if (state.streaming && !wasStreaming) {
      stickToBottom = true;
      maybeScrollToBottom(true);
    }
  }

  /**
   * Show slim icon bar under the bubble (in-flow).
   * Only adjusts scroll on first open — never while moving within the same bubble
   * (crossing thoughts/tools was resetting scroll).
   */
  function placeActionsBar(msgEl, opts) {
    if (!msgEl) return;
    const bar = msgEl.querySelector('.sc-msg-actions');
    const sc = scrollEl();
    if (!bar || !sc) return;

    const alreadyOpen = msgEl.classList.contains('actions-open');
    bar.classList.add('visible');
    msgEl.classList.add('actions-open');

    // Skip scroll nudge if already open or user has scrolled away from bottom
    if (alreadyOpen || opts?.skipScroll) return;
    if (!stickToBottom) return;

    requestAnimationFrame(() => {
      // Bail if user scrolled away during the frame
      if (!stickToBottom) return;
      const scRect = sc.getBoundingClientRect();
      const barRect = bar.getBoundingClientRect();
      const pad = 8;
      if (barRect.bottom > scRect.bottom - pad) {
        sc.scrollTop += barRect.bottom - scRect.bottom + pad + 4;
      }
    });
  }

  function hideAllActionBars() {
    document.querySelectorAll('.sc-msg.actions-open').forEach((el) => {
      el.classList.remove('actions-open');
    });
    document.querySelectorAll('.sc-msg-actions.visible').forEach((el) => {
      el.classList.remove('visible');
    });
  }

  window.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === 'state') {
      // Clear live stream collapsible prefs when session/messages fully refresh
      if (!msg.payload || !msg.payload.streaming) streamUserClosed.clear();
      applyState(msg.payload || {});
    } else if (msg.type === 'stream') {
      const payload = msg.payload || null;
      // Ignore empty residual payloads that would re-show an old timeline
      // after we already cleared for a new send.
      if (
        payload &&
        payload.streaming &&
        state.streaming &&
        state.stream &&
        !state.stream.timeline?.length &&
        !state.stream.fullText &&
        payload.timeline?.length &&
        payload.startTime &&
        state.stream.startTime &&
        payload.startTime < state.stream.startTime - 500
      ) {
        // Stale stream from a previous turn — drop
        return;
      }
      state.streaming = !!(payload && payload.streaming && !payload.done);
      state.stream = payload;
      if (payload && payload.done) {
        state.streaming = false;
        streamUserClosed.clear();
      }
      if (!payload || (!payload.streaming && payload.done)) {
        // Keep done payload only briefly; full state will fold into messages
      }
      renderStream();
      renderStatus();
    } else if (msg.type === 'toast') toast(msg.level, msg.text);
  });

  // Remember user open/close for live stream details
  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!(d instanceof HTMLDetailsElement)) return;
      if (!d.closest('#stream')) return;
      const k = d.getAttribute('data-seg');
      if (!k) return;
      if (d.open) streamUserClosed.delete(k);
      else streamUserClosed.add(k);
    },
    true
  );

  // After selection ends, flush a deferred stream render
  document.addEventListener('selectionchange', () => {
    if (!streamRenderPending) return;
    if (hasSelectionIn($('stream')) || hasSelectionIn(scrollEl())) return;
    streamRenderPending = false;
    if (state.streaming) renderStream();
  });

  function on(id, evt, fn) {
    const el = $(id);
    if (!el) {
      console.warn('[vsgrok] missing element #' + id);
      return;
    }
    el.addEventListener(evt, fn);
  }

  function autosizePrompt() {
    const el = $('prompt');
    if (!el) return;
    el.style.height = 'auto';
    const cs = window.getComputedStyle(el);
    const maxPx = parseFloat(cs.maxHeight) || 320;
    const next = Math.min(el.scrollHeight, maxPx);
    el.style.height = Math.max(next, 48) + 'px';
    el.style.overflowY = el.scrollHeight > maxPx + 1 ? 'auto' : 'hidden';
  }

  // Scroll lock: unlock when user scrolls up; re-lock at bottom
  on('scroll', 'scroll', () => {
    const el = scrollEl();
    if (!el) return;
    stickToBottom = isNearBottom(el, 64);
  });

  on('btnSend', 'click', () => {
    const text = ($('prompt') && $('prompt').value) || '';
    if (!text.trim() || state.streaming) return;
    const model = ($('modelSelect') && $('modelSelect').value) || state.selectedModel;

    // Pending user bubble lives outside `state` so host fullState cannot wipe it.
    // Paint before postMessage so it is visible for the whole AI turn.
    const userText = text.trim();
    pendingUserBubble = {
      id: 'local-' + Date.now(),
      role: 'user',
      content: userText,
      createdAt: Date.now(),
    };
    // Also put into messages for setState / host merge, but pending is source of truth.
    state.messages = [
      ...(state.messages || []).filter((m) => !(m && String(m.id || '').startsWith('local-'))),
      {
        id: pendingUserBubble.id,
        role: 'user',
        content: userText,
        createdAt: pendingUserBubble.createdAt,
      },
    ];
    // Clear prior stream shell immediately so previous tools/thoughts never
    // reappear in the live bubble while waiting for the host.
    state.streaming = true;
    state.stream = {
      streaming: true,
      done: false,
      fullText: '',
      thinkingSummary: '',
      toolCount: 0,
      timeline: [],
      model: '',
      startTime: Date.now(),
      error: null,
      interrupted: false,
      duration: 0,
      messageId: null,
    };
    streamUserClosed.clear();
    stickToBottom = true;
    try {
      vscode.setState({
        sessionId: state.sessionId,
        messages: state.messages,
        sessionTitle: state.sessionTitle,
      });
    } catch {
      /* ignore */
    }
    renderMessages();
    renderStream();
    renderStatus();
    maybeScrollToBottom(true);

    vscode.postMessage({ type: 'send', text: userText, model });
    if ($('prompt')) {
      $('prompt').value = '';
      autosizePrompt();
    }
  });

  on('btnStop', 'click', () => {
    vscode.postMessage({ type: 'stop' });
  });

  on('prompt', 'input', () => {
    autosizePrompt();
    renderStatus();
  });
  on('prompt', 'keydown', (e) => {
    const enterSends = state.enterToSend;
    if (enterSends && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const b = $('btnSend');
      if (b) b.click();
    } else if (!enterSends && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const b = $('btnSend');
      if (b) b.click();
    } else {
      requestAnimationFrame(autosizePrompt);
    }
  });
  requestAnimationFrame(autosizePrompt);

  on('btnHistory', 'click', () => toggleWrap('historyWrap'));
  on('btnNotes', 'click', () => toggleWrap('notesWrap'));
  on('btnSettings', 'click', () => toggleWrap('settingsWrap'));
  on('usageChip', 'click', () => {
    closePopovers();
    const w = $('settingsWrap');
    if (w) w.classList.add('open');
    vscode.postMessage({ type: 'refreshUsage' });
  });
  on('usageRefresh', 'click', () => vscode.postMessage({ type: 'refreshUsage' }));
  on('btnNew', 'click', () => {
    closePopovers();
    vscode.postMessage({ type: 'newSession' });
  });
  on('btnContext', 'click', () => {
    contextOn = !contextOn;
    renderStatus();
    vscode.postMessage({ type: 'setSetting', key: 'includeSelection', value: contextOn });
  });
  on('btnLogin', 'click', () => vscode.postMessage({ type: 'loginGrok' }));
  on('btnBridge', 'click', () => vscode.postMessage({ type: 'startBridge' }));
  on('btnApply', 'click', () =>
    vscode.postMessage({ type: 'applyMarkdown', markdown: lastAssistantMarkdown })
  );

  on('sessionList', 'click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-sid]') : null;
    if (!btn) return;
    closePopovers();
    vscode.postMessage({ type: 'switchSession', id: btn.getAttribute('data-sid') });
  });

  on('modelSelect', 'change', () =>
    vscode.postMessage({ type: 'setModel', model: $('modelSelect').value })
  );
  on('effortSelect', 'change', () =>
    vscode.postMessage({
      type: 'setReasoningEffort',
      effort: $('effortSelect').value,
    })
  );

  function bindSetting(id, key, invert) {
    on(id, 'change', () => {
      let v = $(id).checked;
      if (invert) v = !v;
      vscode.postMessage({ type: 'setSetting', key, value: v });
    });
  }
  bindSetting('setHistory', 'useHistory');
  bindSetting('setEnterNewline', 'enterToSend', true);
  bindSetting('setShowTools', 'showTools');
  bindSetting('setShowThoughts', 'showThinking');

  on('notesAdd', 'click', () => {
    const text = (($('notesInput') && $('notesInput').value) || '').trim();
    if (!text) return;
    const notes = [...(state.notes || []), { id: String(Date.now()), text, enabled: true }];
    if ($('notesInput')) $('notesInput').value = '';
    vscode.postMessage({ type: 'saveNotes', notes });
  });
  on('notesList', 'change', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('input[data-note-i]')) {
      const i = Number(t.getAttribute('data-note-i'));
      const notes = (state.notes || []).map((n, idx) =>
        idx === i ? { ...n, enabled: t.checked } : n
      );
      vscode.postMessage({ type: 'saveNotes', notes });
    }
  });
  on('notesList', 'click', (e) => {
    const t = e.target;
    if (t && t.matches && t.matches('[data-note-del]')) {
      const i = Number(t.getAttribute('data-note-del'));
      const notes = (state.notes || []).filter((_, idx) => idx !== i);
      vscode.postMessage({ type: 'saveNotes', notes });
    }
  });

  // Slim icon bar always under the bubble; leave delay to reach buttons.
  // mouseenter/mouseleave on the message (not mouseover on every child) so
  // crossing thoughts/tools does not re-fire open/scroll.
  let actionsLeaveTimer = null;
  let activeActionsMsg = null;

  function openActionsFor(msg) {
    if (!msg || msg.getAttribute('data-mid') === '__stream__') return;
    if (actionsLeaveTimer) {
      clearTimeout(actionsLeaveTimer);
      actionsLeaveTimer = null;
    }
    if (activeActionsMsg === msg) {
      // Already open for this bubble — do nothing (preserves scroll)
      return;
    }
    if (activeActionsMsg && activeActionsMsg !== msg) {
      hideAllActionBars();
    }
    activeActionsMsg = msg;
    placeActionsBar(msg);
  }

  function scheduleCloseActions(msg) {
    if (actionsLeaveTimer) clearTimeout(actionsLeaveTimer);
    actionsLeaveTimer = setTimeout(() => {
      if (activeActionsMsg === msg) {
        hideAllActionBars();
        activeActionsMsg = null;
      }
      actionsLeaveTimer = null;
    }, 220);
  }

  document.addEventListener(
    'mouseover',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;
      const msg = t.closest('.sc-msg[data-mid]');
      if (!msg || msg.getAttribute('data-mid') === '__stream__') return;
      // Ignore transitions between descendants of the same message
      const from = e.relatedTarget;
      if (from instanceof HTMLElement && msg.contains(from)) return;
      openActionsFor(msg);
    },
    true
  );
  document.addEventListener(
    'mouseout',
    (e) => {
      const t = e.target;
      const related = e.relatedTarget;
      if (!(t instanceof HTMLElement)) return;
      const msg = t.closest('.sc-msg');
      if (!msg || msg !== activeActionsMsg) return;
      // Still inside this message (e.g. thought → tool) — keep open, no scroll work
      if (related instanceof HTMLElement && msg.contains(related)) return;
      scheduleCloseActions(msg);
    },
    true
  );

  function openLink(href) {
    if (!href) return;
    const u = String(href).trim();
    if (!/^(https?:|mailto:)/i.test(u)) return;
    vscode.postMessage({ type: 'openExternal', url: u });
  }

  // Capture-phase so links win over other handlers; works during stream
  document.addEventListener(
    'click',
    (e) => {
      const t = e.target;
      if (!(t instanceof HTMLElement)) return;

      const a = t.closest('a[href]');
      if (a && (a.hasAttribute('data-ext') || a.classList.contains('sc-link') || /^(https?:|mailto:)/i.test(a.getAttribute('href') || ''))) {
        e.preventDefault();
        e.stopPropagation();
        openLink(a.getAttribute('href'));
        return;
      }
    },
    true
  );

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLElement)) return;
    if (!t.closest('.sc-wrap')) closePopovers();

    const actBtn = t.closest('.sc-msg-actions [data-act]');
    if (actBtn) {
      e.preventDefault();
      e.stopPropagation();
      const bar = actBtn.closest('.sc-msg-actions');
      const id = bar && bar.getAttribute('data-mid');
      const act = actBtn.getAttribute('data-act');
      const msg = (state.messages || []).find((m) => m.id === id);
      if (act === 'copy') {
        const text = (msg && msg.content) || '';
        navigator.clipboard.writeText(text).then(
          () => toast('info', 'Copied'),
          () => toast('error', 'Copy failed')
        );
      } else if (act === 'hide' && id) {
        vscode.postMessage({
          type: 'excludeMessage',
          id,
          excluded: !(msg && msg.excludedFromContext),
        });
      } else if (act === 'delete' && id) {
        vscode.postMessage({ type: 'deleteMessage', id });
      }
      return;
    }

    if (t.matches('button[data-copy]')) {
      const pre = t.closest('.sc-code-block')?.querySelector('code');
      if (pre) {
        navigator.clipboard.writeText(pre.textContent || '');
        toast('info', 'Copied');
      }
    }
    if (t.matches('button[data-apply-path]')) {
      const pre = t.closest('.sc-code-block')?.querySelector('code');
      const p = t.getAttribute('data-apply-path');
      if (pre && p) {
        vscode.postMessage({
          type: 'applyMarkdown',
          markdown: '```' + p + '\n' + (pre.textContent || '') + '\n```',
        });
      }
    }
  });

  // Timer only — never full re-render (that was closing details every second)
  setInterval(() => {
    if (state.streaming) updateStreamMetaOnly();
  }, 1000);

  // Restore last transcript from webview state while host reloads (IDE reload /
  // panel recreate). Host state push will replace this with the durable merge.
  try {
    const cached = vscode.getState && vscode.getState();
    if (cached && Array.isArray(cached.messages) && cached.messages.length) {
      state.messages = cached.messages;
      if (cached.sessionId) state.sessionId = cached.sessionId;
      if (cached.sessionTitle) state.sessionTitle = cached.sessionTitle;
      renderMessages();
    }
  } catch {
    /* ignore */
  }

  vscode.postMessage({ type: 'ready' });
})();
