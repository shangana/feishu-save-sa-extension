/* 飞书文档转存 - content script
 * 结果导向：转存后内容/样式与原文一致。
 * 1) 能原生 → explorer/v2/clone（服务端原件）
 * 2) 禁止创建副本 → 全量数据/DOM 高保真重建
 * 零配置：Cookie 登录态。
 */
(() => {
  'use strict';

  const CLIP_VERSION = '1.0.75';
  const EXT_VERSION = '2.28.6';
  const DOM_ENOUGH_LINKS = 3;
  const LINK_RATIO_ABORT = 0.7;
  const CLIENT_VARS_PAGE_LIMIT = 1000; // 续页兜底（对齐 LarkSnap），真正退出看 has_more/新块
  const SKIP_FETCH_CONCURRENCY = 4;
  const SKIP_FETCH_MAX_ROUNDS = 40;
  const SKIP_FETCH_MAX_REQUESTS = 5000;
  const BT = globalThis.FxferBlockTree;
  const SF = globalThis.FxferStyleFidelity;
  const HN = globalThis.FxferHtmlNormalize;
  if (!BT) {
    console.error('[fxfer] FxferBlockTree 未加载：请确认 manifest 已包含 core/block-tree.js');
  }
  if (!SF) {
    console.error('[fxfer] FxferStyleFidelity 未加载：请确认 manifest 已包含 core/style-fidelity.js');
  }
  if (!HN) {
    console.error('[fxfer] FxferHtmlNormalize 未加载：请确认 manifest 已包含 core/html-normalize.js');
  }
  // 内容完整性门槛（优先于样式）：上传前 HTML 相对原文、转存后目标相对原文
  const CHAR_RATIO_ABORT = 0.98;   // 上传前低于此比例 → 中止（采集丢字）
  const CHAR_RATIO_WARN = 0.995;   // 转存后低于此比例 → 判定内容不完整
  const CHAR_ABS_SLACK = 2;        // 绝对字数容差（短文避免误杀）
  // 无法可靠还原结构、但至少要保住可见文字的块
  const FALLBACK_BLOCK_TYPES = /^(equation|whiteboard|sheet|bitable|iframe|isv|addon|synced_source|mindnote|diagram|chart|base|ai|poll|task|meeting_minutes)$/i;
  const REQ_SOURCE = 'feishu-clipper';
  const COVER = '//lf-package-cn.feishucdn.com/obj/feishu-static/ccm-vmok/web/feishu.ico';
  // 软目标：超过就自动加压，尽量压到这个体积再上传（兼顾飞书解析与浏览器内存）
  const HTML_SOFT_TARGET = 80 * 1024 * 1024;
  // 硬上限：加压/丢大图后仍超过才拒绝。再往上（如 500MB）字符串拷贝易把标签页撑爆，收益很小
  const MAX_HTML_BYTES = 200 * 1024 * 1024;
  const MAX_IMG_BYTES = 8 * 1024 * 1024;
  const MAX_MEDIA_BYTES = 200 * 1024 * 1024;      // 单个视频/附件上限，超过直接跳过（不下载）
  const IMG_COMPRESS_BYTES = 350 * 1024;          // 超过此体积的图片默认再压缩
  const IMG_MAX_DIM = 2200;                       // 长边上限，够读文字又大幅省体积
  const IMG_JPEG_QUALITY = 0.82;
  const STORAGE_FOLDER_KEY = 'fxfer_last_folder';
  const STORAGE_COPY_API_KEY = 'fxfer_drive_copy_api';
  const STORAGE_ROOT_TOKEN_KEY = 'fxfer_myspace_root';
  const OBJ_TYPE_FOLDER = 0;
  const OBJ_TYPE_DOCX = 22;
  const OBJ_TYPE_NAME = { 22: 'docx', 2: 'doc', 3: 'sheet', 8: 'bitable', 11: 'mindnote', 12: 'file' };

  const SCROLL_SEL = '.bear-web-x-container';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randId = (n = 32) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stripInvisible = (s) => String(s == null ? '' : s).replace(ZERO_WIDTH_RE, '');

  function cleanTitleText(s) {
    let t = stripInvisible(String(s || '')).replace(/\s+/g, ' ').trim();
    t = t.replace(/\s*[-–—|]\s*(Feishu Docs|Lark Docs|飞书云文档|飞书文档|飞书)\s*$/i, '');
    t = t.replace(/\.html$/i, '').trim();
    return t;
  }

  /** 页面可见标题（page 块 / 顶栏），比 document.title 更稳 */
  function docTitleFromDom() {
    const sels = [
      `${SCROLL_SEL} [data-block-type="page"] .zone-container`,
      `${SCROLL_SEL} [data-block-type="page"]`,
      '.suite-body-title', '.note-title', '.doc-title',
      '[data-testid="doc-title"]', '.page-block-content .text-block'
    ];
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      // page 容器太大时只取首行可见标题
      let t = '';
      if (el.getAttribute && el.getAttribute('data-block-type') === 'page') {
        const zone = el.querySelector('.zone-container, [data-zone-id], .text-block') || el;
        t = (zone.innerText || zone.textContent || '').split('\n').map(x => x.trim()).find(Boolean) || '';
      } else {
        t = (el.innerText || el.textContent || '').split('\n').map(x => x.trim()).find(Boolean) || '';
      }
      t = cleanTitleText(t);
      if (t && t.length >= 2 && t.length < 200) return t;
    }
    return '';
  }

  function docTitleFromTab() {
    return cleanTitleText(document.title || '') || '';
  }

  function titleFromHtmlH1(html) {
    const m = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    if (!m) return '';
    return cleanTitleText(m[1].replace(/<[^>]+>/g, ' ')) || '';
  }

  /** 把相对 /wiki /docx /file 链成绝对地址；drive-stream 预览链改成 /file/token（parse_html 才留得住） */
  function pageOrigin() {
    try { return location.origin || ''; } catch (e) { return ''; }
  }
  function absolutizeHref(href) {
    if (HN) return HN.normalizeHrefForParse(href, pageOrigin());
    const h = String(href || '').trim();
    if (!h) return '';
    if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h;
    if (h.charAt(0) === '/') {
      try { return location.origin + h; } catch (e) { return h; }
    }
    return h;
  }

  const docTitle = () => docTitleFromDom() || docTitleFromTab() || '转存文档';

  /**
   * 转存标题优先级：知识库节点名 > 模型/HTML 的 page h1 > 页面 DOM 标题 > 浏览器标签。
   * 避免把正文某个章节标题误当成整篇文档名。
   */
  async function resolveTransferTitle(html) {
    let wikiTitle = '';
    try {
      const source = await resolveSourceObj();
      if (source && source.wiki) {
        const info = await fetchWikiNode(source.wiki);
        if (info && info.title) wikiTitle = cleanTitleText(info.title);
      }
    } catch (e) { }
    const h1 = titleFromHtmlH1(html);
    const dom = docTitleFromDom();
    const tab = docTitleFromTab();
    // 若 h1 明显短于 wiki/标签且 wiki/标签含「第N课」等课名，优先用 wiki/标签
    const lessonRe = /第\s*\d+\s*课|训练营|成长路线|开营/;
    if (wikiTitle && wikiTitle.length >= 2) {
      if (!h1 || wikiTitle === h1 || wikiTitle.includes(h1) || h1.includes(wikiTitle)) return wikiTitle;
      if (lessonRe.test(wikiTitle) && (!lessonRe.test(h1) || wikiTitle.length >= h1.length)) return wikiTitle;
      return wikiTitle;
    }
    if (tab && lessonRe.test(tab) && h1 && !lessonRe.test(h1) && tab.length > h1.length) return tab;
    if (dom && lessonRe.test(dom) && h1 && !lessonRe.test(h1) && dom.length > h1.length) return dom;
    return h1 || dom || tab || '转存文档';
  }

  /** 保证 HTML 里 page 级 h1 与提交标题一致（parse_html 常拿首个 h1 当文档名） */
  function syncLeadingH1(html, title) {
    const t = cleanTitleText(title);
    if (!t || !html) return html;
    const body = String(html);
    // 跳过文首说明 blockquote 后的第一个 h1
    const h1Re = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
    const m = body.match(h1Re);
    if (!m) {
      // 没有 h1：在文首说明后插入
      if (/<\/blockquote>/i.test(body)) {
        return body.replace(/<\/blockquote>/i, '</blockquote><h1>' + esc(t) + '</h1>');
      }
      return '<h1>' + esc(t) + '</h1>' + body;
    }
    const cur = cleanTitleText(m[1].replace(/<[^>]+>/g, ' '));
    if (cur === t) return body;
    // 仅当现有 h1 不像完整课名、而 title 更像时替换
    const lessonRe = /第\s*\d+\s*课|训练营|成长路线|开营/;
    if (lessonRe.test(t) && (!lessonRe.test(cur) || t.length >= cur.length + 4)) {
      return body.replace(h1Re, '<h1>' + esc(t) + '</h1>');
    }
    if (!cur || cur.length < 2) {
      return body.replace(h1Re, '<h1>' + esc(t) + '</h1>');
    }
    return body;
  }

  /* 从元素里找媒体 token（飞书把 token 放在 cover/download 链接里） */
  function findMediaToken(el) {
    const html = el.outerHTML || '';
    const m = html.match(/\/download\/(?:v2\/)?(?:cover|all|preview)\/([A-Za-z0-9]{20,32})/);
    return m ? m[1] : '';
  }

  /* 表格等内嵌滚动容器：把它们的内部也滚一遍，否则单元格内容不渲染 */
  async function scrollInnerContainers() {
    const inner = [...document.querySelectorAll(
      '.docx-table-block .scrollable-container, .docx-table-block .scrollable-wrapper, .grid-view .scrollable-container,'
      + ' .ace_scrollbar, .ace_scroller, .cm-scroller, .cm-editor, [data-block-type="code"] .zone-container'
    )];
    for (const el of inner) {
      try {
        if (el.scrollHeight > el.clientHeight + 20) {
          el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(120, Math.floor(el.clientHeight * 0.8)));
        }
        if (el.scrollWidth > el.clientWidth + 20) {
          el.scrollLeft = Math.min(el.scrollWidth, el.scrollLeft + Math.max(200, Math.floor(el.clientWidth * 0.8)));
        }
      } catch (e) { }
    }
  }

  function blobToDataURLRaw(blob) {
    return new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('读取失败'));
      fr.readAsDataURL(blob);
    });
  }

  /* 用 canvas 压到 JPEG；动图/失败则返回 null，调用方保留原图 */
  async function compressImageBlob(blob, maxDim, quality) {
    if (!blob || !blob.size) return null;
    if (blob.type === 'image/gif') return null;
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch (e) {
      return null;
    }
    try {
      let w = bitmap.width, h = bitmap.height;
      if (!w || !h) return null;
      const scale = Math.min(1, maxDim / Math.max(w, h));
      if (scale === 1 && blob.size <= IMG_COMPRESS_BYTES) return null;
      w = Math.max(1, Math.round(w * scale));
      h = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) return null;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, 0, 0, w, h);
      const out = await new Promise((resolve) => {
        try { canvas.toBlob(resolve, 'image/jpeg', quality); }
        catch (e) { resolve(null); }
      });
      if (!out || !out.size || out.size >= blob.size) return null;
      return out;
    } finally {
      try { bitmap.close(); } catch (e) { }
    }
  }

  async function blobToEmbeddedDataURL(blob, opts) {
    const maxDim = (opts && opts.maxDim) || IMG_MAX_DIM;
    const quality = (opts && opts.quality) || IMG_JPEG_QUALITY;
    const force = !!(opts && opts.force);
    let use = blob;
    if (force || blob.size > IMG_COMPRESS_BYTES) {
      const c = await compressImageBlob(blob, maxDim, quality);
      if (c) use = c;
    }
    return await blobToDataURLRaw(use);
  }

  /* 采集当刻就把图片取成 base64（飞书图片多是 blob: 临时地址，块卸载后即失效） */
  async function inlineBlockImages(el, html) {
    const imgs = [...el.querySelectorAll('img')];
    if (!imgs.length) return html;
    let out = html;
    for (const im of imgs) {
      const src = im.currentSrc || im.getAttribute('src') || '';
      if (!src || src.startsWith('data:') || src.startsWith('chrome')) continue;
      try {
        const r = await fetch(src, src.startsWith('blob:') ? {} : { credentials: 'include' });
        if (!r.ok) continue;
        const bl = await r.blob();
        if (!bl.size || bl.size > MAX_IMG_BYTES) continue;
        if (bl.type && !/^image\//.test(bl.type) && !src.startsWith('blob:')) continue;
        const d = await blobToEmbeddedDataURL(bl);
        if (d) out = out.split('src="' + src + '"').join('src="' + d + '"');
      } catch (e) { }
    }
    return out;
  }

  /* 媒体块取名：视频块的 innerText 是播放器 UI 文本，只从中提取真正的文件名 */
  function mediaName(e) {
    const t = stripInvisible((e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim());
    const attrs = [
      e.getAttribute && e.getAttribute('data-file-name'),
      e.getAttribute && e.getAttribute('aria-label'),
      e.getAttribute && e.getAttribute('title')
    ].filter(Boolean).join(' ');
    const bag = (attrs + ' ' + t).trim();
    const m = bag.match(/([^\s\\/]+?\.(?:mp4|mov|m4v|webm|avi|mkv|txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|rar|png|jpe?g|gif))/i);
    if (m) return m[1].slice(0, 120);
    const cleaned = t.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ')
      .replace(/Unable to print|Picture-in-Picture|Replay|Play|Live|Fullscreen|PIP|Original|Click and hold to drag/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, 80) || '附件';
  }

  /* 块内嵌套媒体（view/file，常见于表格单元格里）：登记 token 并替换成占位 */
  function extractNestedMedia(clone, register) {
    const nodes = [...clone.querySelectorAll('[data-block-type="view"],[data-block-type="file"],.docx-view-block,.docx-file-block')];
    for (const n of nodes) {
      if (!n.parentNode) continue;
      const html = n.outerHTML || '';
      const rec = n.getAttribute('data-record-id') || '';
      const tok = (html.match(/\/download\/(?:v2\/)?(?:cover|all|preview)\/([A-Za-z0-9]{20,32})/) || [])[1] || rec;
      if (!tok) { n.remove(); continue; }
      const name = mediaName(n);
      const mid = n.getAttribute('data-block-id') || ('m' + Math.floor(Math.random() * 1e6));
      register(mid, tok, name);                       // 去重只决定"是否新建登记"，位置必须保留
      const ph = clone.ownerDocument.createElement('div');
      ph.setAttribute('data-fxfer-media', mid);
      n.replaceWith(ph);
    }
  }

  /* 单元格在文档中的稳定坐标（相对主滚动容器），避免视口 top 因滚动把表头排到最下 */
  function cellStablePos(cell, tableEl, scroller) {
    const cr = cell.getBoundingClientRect();
    if (cr.width === 0 && cr.height === 0) return null;
    // 优先：相对表格的视觉偏移（同一次布局内最稳）
    if (tableEl) {
      const tr = tableEl.getBoundingClientRect();
      if (tr.width > 0 || tr.height > 0) {
        return {
          top: Math.round(cr.top - tr.top),
          left: Math.round(cr.left - tr.left),
          abs: false
        };
      }
    }
    // 退路：相对主滚动容器内容坐标（跨滚动仍近似稳定）
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      return {
        top: Math.round(cr.top - sr.top + scroller.scrollTop),
        left: Math.round(cr.left - sr.left + scroller.scrollLeft),
        abs: true
      };
    }
    return { top: Math.round(cr.top), left: Math.round(cr.left), abs: true };
  }

  function readCellGridIndex(cell) {
    const rowKeys = ['data-row-index', 'data-row', 'data-rowindex', 'rowindex', 'data-y'];
    const colKeys = ['data-col-index', 'data-col', 'data-column-index', 'data-column', 'colindex', 'data-x'];
    let row = null, col = null;
    for (const k of rowKeys) {
      const v = cell.getAttribute(k);
      if (v != null && v !== '' && !Number.isNaN(+v)) { row = +v; break; }
    }
    for (const k of colKeys) {
      const v = cell.getAttribute(k);
      if (v != null && v !== '' && !Number.isNaN(+v)) { col = +v; break; }
    }
    // 部分飞书表格把行列写在 style/grid 或 aria
    if (row == null) {
      const aria = cell.getAttribute('aria-rowindex');
      if (aria && !Number.isNaN(+aria)) row = Math.max(0, +aria - 1);
    }
    if (col == null) {
      const aria = cell.getAttribute('aria-colindex');
      if (aria && !Number.isNaN(+aria)) col = Math.max(0, +aria - 1);
    }
    return { row, col };
  }

  function clusterTableRows(info) {
    if (!info.length) return [];
    // 有显式 row 时按 row 聚类
    if (info.every(it => typeof it.row === 'number')) {
      const map = new Map();
      for (const it of info) {
        if (!map.has(it.row)) map.set(it.row, { top: it.top, row: it.row, cells: [] });
        map.get(it.row).cells.push(it);
      }
      return [...map.values()].sort((a, b) => a.row - b.row);
    }
    info.sort((a, b) => a.top - b.top || a.left - b.left || (a.domIndex || 0) - (b.domIndex || 0));
    const heights = info.map(it => it.height || 0).filter(h => h > 0).sort((a, b) => a - b);
    const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 32;
    const thresh = Math.max(16, Math.min(48, Math.round(medianH * 0.55)));
    const rows = [];
    for (const it of info) {
      const row = rows.find(x => Math.abs(x.top - it.top) < thresh);
      if (row) {
        row.cells.push(it);
        row.top = (row.top * (row.cells.length - 1) + it.top) / row.cells.length;
      } else {
        rows.push({ top: it.top, cells: [it] });
      }
    }
    rows.sort((a, b) => a.top - b.top);
    return rows;
  }

  function looksLikeHeaderRow(cells) {
    const texts = cells.map(c => stripInvisible(String(c.html || '').replace(/<[^>]+>/g, ' ')).trim());
    const joined = texts.join(' ');
    // 常见表头词，或整行都是短标签
    if (/工具名称|对比维度|序号|名称|标题|类型|状态|价格|特点|网址|国内可用|好用程度/.test(joined)) return true;
    const short = texts.filter(t => t && t.length <= 12).length;
    return texts.length >= 2 && short >= Math.ceil(texts.length * 0.7) && texts.every(t => t.length < 40);
  }

  function assembleTableFromCells(info) {
    if (!info.length) return '';
    let rows = clusterTableRows(info.slice());
    // 若表头被错排到非首行，提到最前
    if (rows.length > 1) {
      let hi = -1;
      for (let i = 0; i < rows.length; i++) {
        if (looksLikeHeaderRow(rows[i].cells)) { hi = i; break; }
      }
      if (hi > 0) {
        const [hdr] = rows.splice(hi, 1);
        rows.unshift(hdr);
      }
    }
    let out = '<table>';
    rows.forEach((r, ri) => {
      r.cells.sort((a, b) => {
        if (typeof a.col === 'number' && typeof b.col === 'number' && a.col !== b.col) return a.col - b.col;
        return a.left - b.left || (a.domIndex || 0) - (b.domIndex || 0);
      });
      const tag = ri === 0 && looksLikeHeaderRow(r.cells) ? 'th' : 'td';
      out += '<tr>' + r.cells.map(c => '<' + tag + '>' + (c.html || '') + '</' + tag + '>').join('') + '</tr>';
    });
    return out + '</table>';
  }

  function extractCellInnerHtml(cell, registerMedia) {
    const cl = cloneWithBakedStyles(cell);
    if (registerMedia) extractNestedMedia(cl, registerMedia);
    cl.querySelectorAll(JUNK_SEL).forEach(n => n.remove());
    cl.querySelectorAll('[data-block-type="code"]').forEach(node => {
      const bid = node.getAttribute('data-block-id');
      const live = bid ? cell.querySelector('[data-block-id="' + bid + '"]') : null;
      const repl = extractCodeBlockHtml(live || node);
      if (repl) {
        const wrap = cl.ownerDocument.createElement('div');
        wrap.innerHTML = repl;
        if (wrap.firstChild) node.replaceWith(wrap.firstChild);
      }
    });
    simplifyDocLinks(cl);
    return cl.innerHTML;
  }

  /* 飞书表格是 div 网格，导入器认不出；按单元格稳定坐标聚类成标准 <table> */
  function buildTableHtml(tableEl, cellHtml, scroller) {
    const cells = [...tableEl.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')];
    if (!cells.length) return null;
    const info = [];
    cells.forEach((c, domIndex) => {
      const pos = cellStablePos(c, tableEl, scroller);
      if (!pos) return;
      const grid = readCellGridIndex(c);
      const r = c.getBoundingClientRect();
      info.push({
        el: c, top: pos.top, left: pos.left, height: Math.round(r.height),
        row: grid.row, col: grid.col, domIndex,
        html: cellHtml(c)
      });
    });
    if (!info.length) return null;
    return assembleTableFromCells(info);
  }

  /* 清理块 HTML：去掉飞书 UI 占位/隐藏层等垃圾 */
  const JUNK_SEL = '.gpf-biz-action-manager-forbidden-placeholder,[data-type="print-forbidden-placeholder"],.docx-block-zero-space,[data-zero-space="true"],.layer-popup,.suspension-comment-area,.docx-block-loading-container';

  /* 飞书代码块是 ACE/CodeMirror 私有 DOM，outerHTML 交给 parse_html 会丢内容；抽成标准 <pre><code> */
  function pickEditorDocText(root) {
    if (!root) return '';
    // CodeMirror 6：view 挂在节点或其子节点上
    const tryCm = (ed) => {
      if (!ed) return '';
      const cands = [ed.cmView, ed.view, ed._cmView, ed.__cmView];
      for (const v0 of cands) {
        const view = (v0 && v0.view) ? v0.view : v0;
        if (view && view.state && view.state.doc && typeof view.state.doc.toString === 'function') {
          const t = view.state.doc.toString();
          if (t && t.length) return t;
        }
      }
      try {
        for (const k of Object.keys(ed)) {
          const v = ed[k];
          if (v && v.state && v.state.doc && typeof v.state.doc.toString === 'function') {
            const t = v.state.doc.toString();
            if (t && t.length) return t;
          }
        }
      } catch (e) { }
      return '';
    };
    try {
      const editors = root.querySelectorAll('.cm-editor, .cm-content');
      for (const ed of editors) {
        const t = tryCm(ed) || tryCm(ed.parentElement);
        if (t) return t;
      }
    } catch (e) { }
    // ACE：优先 env / ace.edit
    try {
      const aceHost = root.querySelector('.ace_editor, .ace-editor') || root.closest('.ace_editor');
      if (aceHost) {
        if (aceHost.env && aceHost.env.editor && typeof aceHost.env.editor.getValue === 'function') {
          const t = aceHost.env.editor.getValue();
          if (t && t.length) return t;
        }
        if (typeof globalThis.ace !== 'undefined' && ace.edit) {
          const ed = ace.edit(aceHost);
          if (ed && typeof ed.getValue === 'function') {
            const t = ed.getValue();
            if (t && t.length) return t;
          }
        }
      }
    } catch (e) { }
    return '';
  }

  function extractCodeText(el) {
    if (!el) return '';
    const bid = el.getAttribute('data-block-id');
    const zone = (bid && el.querySelector('[data-zone-id="' + bid + '"]'))
      || el.querySelector('.zone-container')
      || el;
    const fromApi = pickEditorDocText(zone) || pickEditorDocText(el);
    if (fromApi && fromApi.trim()) {
      return stripInvisible(fromApi).replace(/\u00a0/g, ' ').replace(/\s+$/g, '');
    }
    const contentRoot = zone.querySelector('.cm-content, .ace_content, .ace-content, [class*="code-content"], [class*="CodeContent"]') || zone;
    const lineSel = '.cm-line, .ace-line, .code-line, [class*="codeLine"], [class*="code-line"], [data-type="code-line"]';
    let lineEls = [...contentRoot.querySelectorAll(lineSel)];
    // 去掉行号槽里的节点（绝不对正文做「相邻去重」——代码里合法重复行会被误删）
    lineEls = lineEls.filter(n => !n.closest('.ace_gutter, .cm-gutters, [class*="gutter"], [class*="line-number"], [class*="lineNumber"]'));
    if (lineEls.length) {
      const lines = lineEls.map(l => stripInvisible((l.textContent || '').replace(/\u00a0/g, ' ')));
      const onlyNums = lines.length >= 2 && lines.every(l => /^\s*\d+\s*$/.test(l));
      if (!onlyNums) return lines.join('\n').replace(/\s+$/g, '');
    }
    // 退路：整块文本，尽量去掉语言标签/复制按钮等 UI 字样（不再删「纯数字行」——那可能是代码）
    let raw = stripInvisible((contentRoot.innerText || contentRoot.textContent || '').replace(/\u00a0/g, ' '));
    raw = raw.replace(/^(Plain Text|纯文本|JavaScript|TypeScript|Python|Java|Go|C\+\+|JSON|XML|HTML|CSS|SQL|Shell|Bash)\s*\n?/i, '');
    raw = raw.replace(/\b(复制|Copy|已复制)\b/g, '');
    return raw.replace(/\n{3,}/g, '\n\n').replace(/\s+$/g, '');
  }

  /** 只认文档标注色（textHighlight class），不采语法高亮主题色 */
  function codeSpanDocColor(span) {
    if (!span) return '';
    const clsHex = HN ? HN.colorFromClassName(span.className || '') : '';
    if (clsHex) return clsHex;
    return '';
  }

  function extractCodeColoredLines(el) {
    if (!el) return null;
    const bid = el.getAttribute('data-block-id');
    const zone = (bid && el.querySelector('[data-zone-id="' + bid + '"]'))
      || el.querySelector('.code-block-zone-container, .code-block-content .zone-container')
      || el.querySelector('.zone-container')
      || el;
    const lineEls = [...zone.querySelectorAll('.ace-line, .cm-line, .code-line')]
      .filter(n => !n.closest('.ace_gutter, .cm-gutters, .code-block-header, .caption-editor, [class*="gutter"], [class*="line-number"]'));
    if (!lineEls.length) return null;
    const lines = [];
    let anyColor = false;
    for (const line of lineEls) {
      const spans = [...line.querySelectorAll('span[data-string], span[data-leaf]')]
        .filter(s => s.getAttribute('data-enter') !== 'true');
      const parts = [];
      if (spans.length) {
        for (const sp of spans) {
          const t = stripInvisible((sp.textContent || '').replace(/\u00a0/g, ' '));
          if (!t) continue;
          const hex = codeSpanDocColor(sp);
          if (hex) anyColor = true;
          parts.push({ text: t, color: hex });
        }
      } else {
        const t = stripInvisible((line.textContent || '').replace(/\u00a0/g, ' ')).replace(/\s+$/g, '');
        if (t) parts.push({ text: t, color: '' });
      }
      if (!parts.length) {
        lines.push({ parts: [{ text: '', color: '' }] });
        continue;
      }
      // 行尾零宽/换行符清理
      lines.push({
        parts: parts.map(p => ({
          text: String(p.text).replace(/\u200b/g, '').replace(/\n/g, ''),
          color: p.color
        }))
      });
    }
    // 去掉纯行号误采
    const texts = lines.map(l => l.parts.map(p => p.text).join(''));
    if (texts.length >= 2 && texts.every(t => /^\s*\d+\s*$/.test(t))) return null;
    if (!lines.length) return null;
    return { lines, anyColor };
  }

  function extractCodeBlockHtml(el) {
    const colored = extractCodeColoredLines(el);
    if (colored && colored.lines.length) {
      if (HN && HN.buildColoredCodeHtml) {
        return HN.buildColoredCodeHtml(colored.lines, '');
      }
      // 无 HN 时退回：有色则整段包一层多数色
      const plain = colored.lines.map(l => l.parts.map(p => p.text).join('')).join('\n');
      if (!plain.trim()) return '';
      if (colored.anyColor) {
        const majority = {};
        colored.lines.forEach(l => l.parts.forEach(p => {
          if (p.color) majority[p.color] = (majority[p.color] || 0) + (p.text || '').length;
        }));
        const hex = Object.keys(majority).sort((a, b) => majority[b] - majority[a])[0];
        if (hex) {
          return '<pre style="white-space:pre-wrap;word-break:break-word"><code>'
            + '<font color="' + hex + '"><span style="color:' + hex + '">' + esc(plain) + '</span></font>'
            + '</code></pre>';
        }
      }
      return '<pre style="white-space:pre-wrap;word-break:break-word"><code>' + esc(plain) + '</code></pre>';
    }
    const text = extractCodeText(el);
    if (!text) return '';
    return '<pre style="white-space:pre-wrap;word-break:break-word"><code>' + esc(text) + '</code></pre>';
  }

  function codeHtmlScore(html) {
    if (!html) return 0;
    const m = String(html).match(/<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/i);
    if (!m) return 0;
    return stripInvisible(m[1].replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).trim().length;
  }

  /** 模型路径：代码块按 apool 字色渲染（textHighlight red → #d83931） */
  function renderCodeHtmlFromBody(body) {
    const bags = [body && body.text, body && body.code];
    if (body && body.code && typeof body.code === 'object') {
      bags.push(body.code.text, body.code.content);
    }
    let bestField = null;
    let bestPlain = '';
    for (const bag of bags) {
      if (bag == null || bag === '') continue;
      const plain = typeof bag === 'string' ? bag : plainFromTextField(bag);
      if (plain && plain.length >= bestPlain.length) {
        bestPlain = plain;
        bestField = typeof bag === 'string' ? null : bag;
      }
    }
    const langSafe = String((body && (body.language || (body.code && body.code.language))) || '')
      .replace(/[^a-zA-Z0-9_+#.-]/g, '');
    if (bestField && HN && HN.buildColoredCodeHtml) {
      const lines = linesFromTextField(bestField);
      const rows = lines.map(line => ({
        parts: line.map(seg => {
          const resolved = HN.resolveInlineColors(seg.attrs || {});
          let hex = resolved.color || '';
          if (hex && !/^#/.test(hex)) hex = HN.mapFeishuColorToken(hex) || '';
          if (hex && (isNearBlack(hex) || isNearWhite(hex))) hex = '';
          return { text: seg.text || '', color: hex };
        })
      }));
      const hasColor = rows.some(r => r.parts.some(p => p.color));
      if (hasColor) return HN.buildColoredCodeHtml(rows, langSafe);
    }
    const plain = bestPlain || plainFromCodeBody(body);
    const lang = langSafe ? ' class="language-' + langSafe + '"' : '';
    return '<pre style="white-space:pre-wrap;word-break:break-word"><code' + lang + '>'
      + esc(plain) + '</code></pre>';
  }

  function parseRgb(c) {
    if (!c) return null;
    const m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3] };
  }
  function isNearBlack(c) {
    const p = parseRgb(c);
    return p ? (p.r + p.g + p.b) < 60 : /^(#000|#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(String(c || '').trim());
  }
  function isNearWhite(c) {
    const p = parseRgb(c);
    return p ? (p.r + p.g + p.b) > 720 : /^(#fff|#ffffff|white)$/i.test(String(c || '').trim());
  }
  function isTransparentBg(c) {
    if (!c || c === 'transparent') return true;
    const m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+))?/);
    if (!m) return false;
    return m[4] !== undefined && Number(m[4]) <= 0.02;
  }
  function rgbToCss(c) {
    const p = parseRgb(c);
    if (!p) return c;
    const hex = '#' + [p.r, p.g, p.b].map(x => x.toString(16).padStart(2, '0')).join('');
    return hex;
  }

  /* 把页面上算出来的颜色/加粗等写进 clone 的 inline style，parse_html 才认得出 */
  function cloneWithBakedStyles(el) {
    const clone = el.cloneNode(true);
    const liveNodes = [el, ...el.querySelectorAll('*')];
    const cloneNodes = [clone, ...clone.querySelectorAll('*')];
    const n = Math.min(liveNodes.length, cloneNodes.length);
    for (let i = 0; i < n; i++) {
      const live = liveNodes[i];
      const c = cloneNodes[i];
      if (!live || !c || live.tagName !== c.tagName) continue;
      // 跳过脚本/样式/svg 内部复杂节点
      if (/^(SCRIPT|STYLE|SVG|PATH|IMG|VIDEO|SOURCE)$/i.test(live.tagName)) continue;
      try {
        const cs = window.getComputedStyle(live);
        if (!cs) continue;
        let color = cs.color;
        // 飞书标题红字常靠 class（textHighlight-pink-text / doc-textcolor-red），不能只信近黑判断漏掉
        const clsHex = HN ? HN.colorFromClassName(live.className || '') : '';
        if (clsHex) color = clsHex;
        if (color && !isNearBlack(color) && !isNearWhite(color)) {
          const hex = /^#/.test(String(color)) ? String(color).toLowerCase() : rgbToCss(color);
          c.style.color = hex;
          // parse_html 对 font[color] / 内联 color 更稳，双写提高保留率
          if (/^(FONT|SPAN|A|B|STRONG|EM|I|U|S|MARK)$/i.test(c.tagName)) {
            try { c.setAttribute('color', hex); } catch (e) { }
          }
        }
        const bg = cs.backgroundColor;
        if (bg && !isTransparentBg(bg) && !isNearWhite(bg)) {
          c.style.backgroundColor = rgbToCss(bg);
        }
        const fw = cs.fontWeight;
        if (fw === 'bold' || fw === '700' || parseInt(fw, 10) >= 600) {
          c.style.fontWeight = 'bold';
        }
        if (cs.fontStyle === 'italic') c.style.fontStyle = 'italic';
        const td = cs.textDecorationLine || cs.textDecoration || '';
        if (/line-through/i.test(td)) c.style.textDecoration = 'line-through';
        else if (/underline/i.test(td)) c.style.textDecoration = 'underline';
        // 字号：明显非正文默认时写入，减少「看起来不一样」
        const fs = parseFloat(cs.fontSize);
        if (fs && (fs <= 12 || fs >= 18)) {
          c.style.fontSize = Math.round(fs) + 'px';
        }
        // 引用/高亮块左边线、内边距（样式尽量像）
        const blw = parseFloat(cs.borderLeftWidth);
        if (blw >= 2) {
          c.style.borderLeft = Math.round(blw) + 'px solid ' + rgbToCss(cs.borderLeftColor || 'rgb(187,187,187)');
          const pl = parseFloat(cs.paddingLeft);
          if (pl > 0) c.style.paddingLeft = Math.round(pl) + 'px';
        }
        const bt = cs.borderTopWidth, br = cs.borderRightWidth, bb = cs.borderBottomWidth;
        if (parseFloat(bt) >= 1 || parseFloat(br) >= 1 || parseFloat(bb) >= 1) {
          // 高亮 callout 常见整框边框
          if (!isTransparentBg(bg) && !isNearWhite(bg)) {
            c.style.border = '1px solid ' + rgbToCss(cs.borderTopColor || cs.borderColor || 'rgb(220,220,220)');
            c.style.borderRadius = (parseFloat(cs.borderRadius) || 4) + 'px';
            const pad = parseFloat(cs.paddingTop);
            if (pad > 0) c.style.padding = Math.max(6, Math.round(pad)) + 'px';
          }
        }
        // 已有内联 color 也保留（上面是补充）
        const exist = live.getAttribute('style') || '';
        const cm = exist.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
        if (cm && cm[1] && !/inherit|initial|var\(/i.test(cm[1])) {
          c.style.color = cm[1].trim();
        }
      } catch (e) { }
    }
    return clone;
  }

  function countPlainChars(s) {
    return stripInvisible(String(s || ''))
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, '')
      .length;
  }

  function charRetention(srcChars, destChars) {
    const src = Math.max(0, srcChars | 0);
    const dest = Math.max(0, destChars | 0);
    const delta = dest - src;
    const ratio = src > 0 ? dest / src : (dest === 0 ? 1 : 0);
    const ok = src === 0
      ? dest === 0
      : (dest >= src - CHAR_ABS_SLACK) || (ratio >= CHAR_RATIO_WARN);
    return {
      src, dest, delta, ratio,
      pct: Math.round(ratio * 1000) / 10,
      ok,
      line: '总字数：源 ' + src + ' → 目标 ' + dest
        + '（差 ' + (delta >= 0 ? '+' : '') + delta
        + '，保留 ' + (Math.round(ratio * 1000) / 10) + '%）'
        + (ok ? ' ✅' : ' ❌ 内容偏少')
    };
  }

  /* 飞书链接：mention / 普通 a.link / drive-stream 预览链 → 干净绝对 /file 或外链（parse_html 才留得住） */
  function simplifyDocLinks(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(
      'a.mention-doc, a.link, a[data-href], a[href], a[data-link-node]'
    ).forEach(a => {
      let href = (a.getAttribute('href') || '').trim();
      if (!href) {
        const dh = (a.getAttribute('data-href') || '').trim();
        if (dh) {
          try { href = decodeURIComponent(dh); } catch (e) { href = dh; }
        }
      }
      href = absolutizeHref(href);
      if (!href || !/^(https?:|mailto:|\/)/i.test(href) || /["'<>\s]/.test(href)) return;
      const text = stripInvisible((a.innerText || a.textContent || '').replace(/\s+/g, ' ')).trim() || href;
      const clean = a.ownerDocument.createElement('a');
      clean.setAttribute('href', href);
      clean.textContent = text;
      try { a.replaceWith(clean); } catch (e) { }
    });
  }

  function countHtmlLinks(html) {
    return HN ? HN.countHtmlLinks(html) : (String(html || '').match(/<a\s[^>]*\bhref\s*=/gi) || []).length;
  }

  function normalizeHtmlLinksInPlace(html) {
    return HN ? HN.normalizeHtmlLinks(html, pageOrigin()) : html;
  }

  /** 把源 HTML 里的 <a> 按可见文案回填到目标（模型路径常丢掉 PDF 预览链） */
  function salvageDomLinksIntoHtml(dstHtml, srcHtml) {
    if (!dstHtml || !srcHtml) return dstHtml;
    const re = /<a\s[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    const pairs = [];
    const seen = new Set();
    let m;
    while ((m = re.exec(String(srcHtml)))) {
      const href = absolutizeHref(m[1]);
      const text = stripInvisible(String(m[2] || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (!href || !text || text.length < 2 || text.length > 180) continue;
      const key = text + '\0' + href;
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ href, text });
    }
    let out = String(dstHtml);
    for (const p of pairs) {
      if (out.indexOf(p.href) >= 0) continue;
      const idx = out.indexOf(p.text);
      if (idx < 0) continue;
      const beforeA = out.lastIndexOf('<a ', idx);
      const beforeClose = out.lastIndexOf('</a>', idx);
      if (beforeA > beforeClose) continue; // 已在某个 <a> 内
      out = out.slice(0, idx)
        + '<a href="' + p.href.replace(/"/g, '') + '">' + p.text + '</a>'
        + out.slice(idx + p.text.length);
    }
    return out;
  }

  function cleanBlockHtml(el, register) {
    const clone = cloneWithBakedStyles(el);
    if (register) extractNestedMedia(clone, register);
    clone.querySelectorAll(JUNK_SEL).forEach(n => n.remove());
    // 嵌套代码块也转成标准 pre/code，避免父容器带着 ACE 空壳
    clone.querySelectorAll('[data-block-type="code"]').forEach(node => {
      if (node === clone) return;
      // 用 live 树对应节点抽文本更准
      const bid = node.getAttribute('data-block-id');
      const live = bid ? el.querySelector('[data-block-id="' + bid + '"]') : null;
      const repl = extractCodeBlockHtml(live || node);
      if (repl) {
        const wrap = clone.ownerDocument.createElement('div');
        wrap.innerHTML = repl;
        if (wrap.firstChild) node.replaceWith(wrap.firstChild);
      }
    });
    clone.querySelectorAll('*').forEach(n => {
      const st = (n.getAttribute && n.getAttribute('style')) || '';
      // 只删“整块隐藏”的，不要误伤带 color 的节点
      if (/^\s*display\s*:\s*none\s*;?\s*$/i.test(st) || /^\s*visibility\s*:\s*hidden\s*;?\s*$/i.test(st)) n.remove();
      else if (/display\s*:\s*none/i.test(st) && !/color\s*:/i.test(st) && !(n.textContent || '').trim()) n.remove();
    });
    clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    simplifyDocLinks(clone);
    return clone.outerHTML;
  }

  function ownBlockText(el) {
    if (!el) return '';
    const bid = el.getAttribute('data-block-id');
    const zone = (bid && el.querySelector('[data-zone-id="' + bid + '"]'))
      || el.querySelector('.zone-container');
    const root = zone || el;
    // 去掉子 block，避免父吞子文本
    const clone = root.cloneNode(true);
    clone.querySelectorAll('[data-block-id]').forEach(n => {
      if (n.getAttribute('data-block-id') !== bid) n.remove();
    });
    return stripInvisible((clone.innerText || clone.textContent || '').replace(/\s+/g, ' ')).trim();
  }

  /* 特殊块：结构保不住时至少把可见文字落成段落，避免「字丢了」 */
  function extractFallbackBlockHtml(el, type) {
    if (!el) return '';
    const t = String(type || el.getAttribute('data-block-type') || 'block');
    let text = ownBlockText(el);
    if (!text) {
      text = stripInvisible(
        el.getAttribute('data-latex')
        || el.getAttribute('aria-label')
        || el.getAttribute('data-content')
        || ''
      ).trim();
    }
    // 画板：尽量带上缩略图，再附说明
    if (/whiteboard|diagram|mindnote/i.test(t)) {
      const img = el.querySelector('img[src]');
      let imgHtml = '';
      if (img && img.getAttribute('src')) {
        imgHtml = '<p><img src="' + esc(img.getAttribute('src')) + '" alt="画板"></p>';
      }
      const label = text ? ('【画板】' + text) : '【画板】（结构无法完整还原，已尽量保留预览/文字）';
      return imgHtml + '<p>' + esc(label) + '</p>';
    }
    if (/equation/i.test(t)) {
      if (!text) return '<p>【公式】</p>';
      return '<p><code>' + esc(text) + '</code></p>';
    }
    if (/sheet|bitable|base/i.test(t)) {
      return '<p>' + esc(text ? ('【表格/多维表】' + text) : '【表格/多维表】（嵌套表无法完整导入，已占位）') + '</p>';
    }
    if (/iframe|isv|addon/i.test(t)) {
      const a = el.querySelector('a[href]');
      const href = a ? a.getAttribute('href') : '';
      return '<p>' + esc(text || '【嵌入内容】')
        + (href ? (' <a href="' + esc(href) + '">' + esc(href) + '</a>') : '')
        + '</p>';
    }
    if (text) return '<p>' + esc(text) + '</p>';
    return '<p>【' + esc(t) + '】（特殊块已占位，防止内容空洞）</p>';
  }

  /* 把模型里更长的代码块灌进 HTML（替换偏短的 <pre><code>，或追加缺失的） */
  function mergeLongerCodesIntoHtml(html, model) {
    const codes = (model && model.inventory && model.inventory.codes) || [];
    if (!codes.length) return { html, added: 0 };
    let out = String(html || '');
    let added = 0;
    const existing = [];
    const re = /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
    let m;
    while ((m = re.exec(out))) {
      const text = stripInvisible(m[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
      const hasColor = /font\s+color\s*=|style\s*=\s*["'][^"']*color\s*:/i.test(m[0]);
      existing.push({ start: m.index, end: m.index + m[0].length, text, raw: m[0], hasColor });
    }
    codes.forEach(c => {
      const full = String((c && c.full) || ((c && c.needle) || []).join('\n') || '').replace(/\s+$/g, '');
      if (full.length < 4) return;
      const fullPlain = full.replace(/\s+/g, '');
      let bestIdx = -1;
      let bestScore = -1;
      existing.forEach((ex, i) => {
        const a = ex.text.replace(/\s+/g, '');
        if (!a.length) return;
        // 同源：一方包含另一方，或共享足够前缀
        const share = (a.length >= 12 && fullPlain.indexOf(a.slice(0, Math.min(40, a.length))) >= 0)
          || (fullPlain.length >= 12 && a.indexOf(fullPlain.slice(0, Math.min(40, fullPlain.length))) >= 0);
        if (!share) return;
        // 页面版已带标注色且字数差不多 → 不要用无色模型盖掉红字
        if (ex.hasColor && a.length >= Math.floor(fullPlain.length * 0.9)) return;
        if (full.length > ex.text.length && full.length - ex.text.length > bestScore) {
          bestScore = full.length - ex.text.length;
          bestIdx = i;
        }
      });
      // 若能从模型 inventory 拿到带色 HTML 更好；否则纯文本（仅补字）
      const block = '<pre style="white-space:pre-wrap;word-break:break-word"><code>' + esc(full) + '</code></pre>';
      if (bestIdx >= 0) {
        const ex = existing[bestIdx];
        if (ex.hasColor && ex.text.replace(/\s+/g, '').length >= Math.floor(fullPlain.length * 0.9)) return;
        out = out.slice(0, ex.start) + block + out.slice(ex.end);
        // 刷新后续索引
        const delta = block.length - (ex.end - ex.start);
        existing[bestIdx] = { start: ex.start, end: ex.start + block.length, text: full, raw: block };
        for (let j = bestIdx + 1; j < existing.length; j++) {
          existing[j].start += delta;
          existing[j].end += delta;
        }
        added++;
        return;
      }
      const probe = full.split('\n').map(l => l.trim()).filter(Boolean)[0] || '';
      if (probe && out.indexOf(esc(probe.slice(0, Math.min(24, probe.length)))) >= 0) return;
      if (probe && out.replace(/<[^>]+>/g, ' ').indexOf(probe.slice(0, Math.min(24, probe.length))) >= 0) return;
      out += '\n' + block;
      existing.push({ start: out.length - block.length, end: out.length, text: full, raw: block });
      added++;
    });
    return { html: out, added };
  }

  /* 上传前补漏：原文块里有、HTML 里找不到的段落，追加进去 */
  function salvageMissingTextIntoHtml(html) {
    const hayRaw = stripInvisible(String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' '));
    const extras = [];
    const seen = new Set();
    const root = document.querySelector(SCROLL_SEL) || document.body;
    for (const e of root.querySelectorAll('[data-block-type]')) {
      const type = e.getAttribute('data-block-type') || '';
      if (!type || type === 'page' || type === 'table_cell' || type === 'table') continue;
      if (e.closest && e.closest('[data-block-type="table_cell"]')) continue;
      let text = '';
      if (type === 'code') text = extractCodeText(e);
      else text = ownBlockText(e);
      text = stripInvisible(String(text || '')).replace(/\s+/g, ' ').trim();
      if (text.length < 6) continue;
      const key = text.slice(0, 80);
      if (seen.has(key)) continue;
      seen.add(key);
      // 取前 24 字做探针：整段太长时也要能发现缺失
      const probe = text.length > 24 ? text.slice(0, 24) : text;
      if (hayRaw.indexOf(probe) >= 0) continue;
      if (type === 'code') {
        extras.push('<pre><code>' + esc(text) + '</code></pre>');
      } else if (FALLBACK_BLOCK_TYPES.test(type)) {
        extras.push(extractFallbackBlockHtml(e, type));
      } else {
        extras.push('<p>' + esc(text) + '</p>');
      }
      if (extras.length >= 80) break;
    }
    if (!extras.length) return { html, added: 0 };
    return {
      html: html + '\n<!-- fxfer-salvage -->\n' + extras.join('\n'),
      added: extras.length
    };
  }

  function makeNeedle(text, maxParts) {
    const parts = String(text || '')
      .split(/[\n。！？；;!?\u3002]+/)
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(s => s.length >= 6);
    const out = [];
    for (const p of parts) {
      out.push(p.slice(0, 40));
      if (out.length >= (maxParts || 2)) break;
    }
    if (!out.length && text && text.trim().length >= 4) out.push(text.trim().slice(0, 40));
    return out;
  }

  /* 源文档内容清单：代码块 + 标题 + 正文要点 + 表格/图片数量 */
  function inventoryFromDom(scope) {
    const root = scope || document;
    const codes = [];
    const headings = [];
    const texts = [];
    const seen = new Set();
    let tables = 0;
    let images = 0;
    const TEXT_TYPES = /^(text|bullet|ordered|todo|quote|callout|heading[1-9])$/;

    for (const e of root.querySelectorAll(`${SCROLL_SEL} [data-block-type], [data-block-type]`)) {
      const type = e.getAttribute('data-block-type') || '';
      const id = e.getAttribute('data-block-id') || '';
      if (type === 'table' || /docx-table-block/.test((e.className || '').toString())) tables++;
      if (type === 'code') {
        const text = extractCodeText(e);
        if (!text || seen.has('c:' + text)) continue;
        seen.add('c:' + text);
        codes.push({
          id, kind: '代码块',
          lines: text.split('\n').length,
          preview: text.split('\n').slice(0, 2).join(' / ').slice(0, 80),
          needle: text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3)
        });
        continue;
      }
      if (/^heading[1-9]$/.test(type)) {
        const t = ownBlockText(e).slice(0, 80);
        if (t && !seen.has('h:' + t)) {
          seen.add('h:' + t);
          headings.push({ kind: '标题', preview: t, needle: makeNeedle(t, 1) });
        }
        continue;
      }
      if (TEXT_TYPES.test(type)) {
        const t = ownBlockText(e);
        if (t.length < 8) continue;
        const key = t.slice(0, 60);
        if (seen.has('t:' + key)) continue;
        seen.add('t:' + key);
        texts.push({ kind: '正文', preview: key, needle: makeNeedle(t, 2) });
      }
    }
    images = root.querySelectorAll(`${SCROLL_SEL} img, [data-block-type="image"] img`).length;
    // 正文要点太多时只保留较长的，避免轻微标点差异刷屏误报
    texts.sort((a, b) => (b.preview || '').length - (a.preview || '').length);
    const textsCapped = texts.slice(0, 60);
    return {
      codes, headings, texts: textsCapped,
      tables, images,
      plain: stripInvisible(((root.querySelector && root.querySelector(SCROLL_SEL)) || root).innerText || '').replace(/\u00a0/g, ' ')
    };
  }

  function inventoryFromHtml(html) {
    const codes = [];
    const re = /<pre[^>]*>\s*<code[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi;
    let m;
    while ((m = re.exec(html))) {
      const text = stripInvisible(m[1]
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"'));
      if (!text.trim()) continue;
      codes.push({
        kind: '代码块',
        lines: text.split('\n').length,
        preview: text.split('\n').slice(0, 2).join(' / ').slice(0, 80),
        needle: text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 3)
      });
    }
    // 保留换行，供逐行核对；块级标签→换行，再清标签
    const plain = stripInvisible(String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<\/(p|div|h[1-6]|li|tr|pre|blockquote|table|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n'));
    const tables = (String(html).match(/<table[\s>]/gi) || []).length;
    const images = (String(html).match(/<img[\s>]/gi) || []).length;
    return { codes, plain, tables, images, headings: [], texts: [] };
  }

  function needlesHit(item, haystack) {
    const needles = item.needle || [];
    if (!needles.length) {
      const p = (item.preview || '').slice(0, 16);
      return !p || haystack.indexOf(p) >= 0;
    }
    // 至少命中一半关键句（避免因轻微标点差异全灭）
    let hit = 0;
    for (const n of needles) {
      if (!n) continue;
      if (haystack.indexOf(n) >= 0 || haystack.indexOf(esc(n)) >= 0) hit++;
    }
    return hit >= Math.ceil(needles.length / 2);
  }

  function auditInventories(src, destHtmlOrInv) {
    const isHtml = typeof destHtmlOrInv === 'string';
    const dest = isHtml ? inventoryFromHtml(destHtmlOrInv) : (destHtmlOrInv || {});
    const hay = isHtml
      ? (dest.plain || '') + '\n' + destHtmlOrInv
      : ((dest.plain || '') + '\n' + (dest.codes || []).map(c => (c.needle || []).join('\n')).join('\n'));
    const missing = [];
    const checkList = []
      .concat(src.codes || [])
      .concat(src.headings || [])
      .concat((src.texts || []).filter(t => (t.preview || '').length >= 12));

    for (const item of checkList) {
      if (!needlesHit(item, hay)) {
        missing.push({ kind: item.kind || '内容', preview: item.preview || '' });
      }
    }

    const warn = [];
    if ((src.tables || 0) > 0 && (dest.tables || 0) < Math.ceil((src.tables || 0) * 0.5)) {
      warn.push('表格数量明显偏少（源 ' + src.tables + ' / 目标 ' + (dest.tables || 0) + '）');
    }
    if ((src.images || 0) >= 3 && (dest.images || 0) < Math.ceil((src.images || 0) * 0.4)) {
      warn.push('图片数量明显偏少（源 ' + src.images + ' / 目标 ' + (dest.images || 0) + '）');
    }

    return {
      missing,
      warn,
      srcCode: (src.codes || []).length,
      destCode: (dest.codes || []).length,
      srcHeading: (src.headings || []).length,
      srcText: (src.texts || []).length,
      srcTable: src.tables || 0,
      destTable: dest.tables || 0,
      srcImage: src.images || 0,
      destImage: dest.images || 0
    };
  }

  function formatAuditReport(pre, post) {
    const lines = [];
    const summarize = (a, label) => {
      if (!a) return;
      lines.push(label + '：标题 ' + (a.srcHeading || 0) + ' / 正文要点 ' + (a.srcText || 0)
        + ' / 代码块 源' + a.srcCode + '→目标' + a.destCode
        + ' / 表格 源' + (a.srcTable || 0) + '→目标' + (a.destTable || 0)
        + ' / 图片 源' + (a.srcImage || 0) + '→目标' + (a.destImage || 0)
        + (a.missing.length ? '；⚠ 疑似缺失 ' + a.missing.length + ' 处' : '（关键内容已对齐）'));
      a.missing.slice(0, 8).forEach(m => lines.push('  · 缺失' + m.kind + '：' + m.preview));
      if (a.missing.length > 8) lines.push('  · …另有 ' + (a.missing.length - 8) + ' 处');
      (a.warn || []).forEach(w => lines.push('  · ' + w));
    };
    summarize(pre, '提交前核查');
    summarize(post, '新文档核查');
    return lines.join('\n');
  }

  /* -------- 转存前后全文快照对比（自动 diff，无需人工逐行看） -------- */

  function normLine(s) {
    return stripInvisible(String(s || ''))
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function colorKey(c) {
    const p = parseRgb(c);
    if (!p) return String(c || '').toLowerCase();
    return [p.r, p.g, p.b].join(',');
  }

  function collectVisibleSnapshotPieces(seenIds) {
    const lines = [];
    const styles = [];
    let tables = 0, images = 0, codes = 0;
    const root = document.querySelector(SCROLL_SEL) || document.body;

    for (const e of root.querySelectorAll('[data-block-type]')) {
      const type = e.getAttribute('data-block-type') || '';
      const id = e.getAttribute('data-block-id') || '';
      if (!id || seenIds.has(id)) continue;
      if (type === 'page' || type === 'table_cell') continue;
      if (e.closest && e.closest('[data-block-type="table_cell"]') && type !== 'table') continue;

      if (type === 'table' || /docx-table-block/.test((e.className || '').toString())) {
        tables++;
        seenIds.add(id);
        // 表格按行抽取纯文本，便于发现表头错位/缺行
        const cells = [...e.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')];
        const rowMap = new Map();
        cells.forEach((cell, idx) => {
          const pos = cellStablePos(cell, e, getScroller());
          const grid = readCellGridIndex(cell);
          const top = typeof grid.row === 'number' ? grid.row * 10000 : (pos ? pos.top : idx * 10);
          const left = typeof grid.col === 'number' ? grid.col : (pos ? pos.left : idx);
          const t = normLine(cell.innerText || cell.textContent || '');
          if (!t) return;
          if (!rowMap.has(top)) rowMap.set(top, []);
          rowMap.get(top).push({ left, t });
        });
        const tops = [...rowMap.keys()].sort((a, b) => a - b);
        tops.forEach((top, ri) => {
          const cols = rowMap.get(top).sort((a, b) => a.left - b.left).map(x => x.t);
          lines.push({ id: id + '#r' + ri, type: 'table_row', text: cols.join(' | ') });
        });
        continue;
      }

      if (type === 'code') {
        codes++;
        const text = extractCodeText(e);
        seenIds.add(id);
        if (text) {
          text.split('\n').forEach((ln, i) => {
            const t = normLine(ln);
            if (t) lines.push({ id: id + '#c' + i, type: 'code', text: t });
          });
        }
        continue;
      }

      const text = ownBlockText(e);
      if (!text || text.length < 1) continue;
      seenIds.add(id);
      lines.push({ id, type: type || 'text', text: normLine(text) });

      // 样式抽样：色/粗/斜/下划/删除/链接/行内代码 + 标题级别
      const bid = id;
      if (/^heading[1-9]$/i.test(type)) {
        const lv = Math.min(6, Math.max(1, Number(String(type).replace(/\D/g, '')) || 1));
        styles.push({ text: normLine(text).slice(0, 80), block: 'h' + lv });
      }
      const zone = e.querySelector('[data-zone-id="' + bid + '"]') || e.querySelector('.zone-container') || e;
      zone.querySelectorAll('span, font, a, b, strong, em, i, u, s, code').forEach(sp => {
        if (sp.closest && sp.closest('[data-block-id]') && sp.closest('[data-block-id]') !== e) return;
        const st = normLine(sp.textContent || '');
        if (st.length < 2 || st.length > 80) return;
        try {
          const cs = getComputedStyle(sp);
          const color = cs.color;
          const bg = cs.backgroundColor;
          const bold = cs.fontWeight === 'bold' || parseInt(cs.fontWeight, 10) >= 600;
          const italic = cs.fontStyle === 'italic';
          const td = cs.textDecoration || cs.textDecorationLine || '';
          const underline = /underline/i.test(td) || sp.tagName === 'U';
          const strike = /line-through/i.test(td) || sp.tagName === 'S';
          const code = sp.tagName === 'CODE';
          const link = sp.tagName === 'A' && !!(sp.getAttribute('href') || '').trim();
          const hasColor = color && !isNearBlack(color) && !isNearWhite(color);
          const hasBg = bg && !isTransparentBg(bg) && !isNearWhite(bg);
          if (hasColor || hasBg || bold || italic || underline || strike || code || link) {
            styles.push({
              text: st.slice(0, 40),
              color: hasColor ? colorKey(color) : '',
              colorRaw: hasColor ? color : '',
              bg: hasBg ? colorKey(bg) : '',
              bgRaw: hasBg ? bg : '',
              bold: !!bold,
              italic: !!italic,
              underline: !!underline,
              strike: !!strike,
              code: !!code,
              link: !!link
            });
          }
        } catch (err) { }
      });
    }

    images += root.querySelectorAll('img').length;
    return { lines, styles, tables, images, codes };
  }

  async function captureDocSnapshot(onProgress) {
    const sc = getScroller();
    const seenIds = new Set();
    const allLines = [];
    const allStyles = [];
    let tables = 0, images = 0, codes = 0;

    const absorb = (piece) => {
      // tables/codes 每轮只计「新看到」的块，需累加；images 是全页查询，取最大值
      tables += piece.tables || 0;
      codes += piece.codes || 0;
      images = Math.max(images, piece.images || 0);
      for (const ln of piece.lines || []) allLines.push(ln);
      for (const st of piece.styles || []) allStyles.push(st);
    };

    absorb(collectVisibleSnapshotPieces(seenIds));
    if (sc) {
      sc.scrollTop = 0;
      await sleep(350);
      absorb(collectVisibleSnapshotPieces(seenIds));
      let stuck = 0, last = -1;
      for (let i = 0; i < 120; i++) {
        if (window.__fxferAbort) break;
        sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(220, Math.floor(sc.clientHeight * 0.65)));
        await sleep(260);
        await scrollInnerContainers();
        absorb(collectVisibleSnapshotPieces(seenIds));
        onProgress && onProgress('采集对比快照 ' + Math.min(99, Math.round((i / 120) * 100)) + '%…');
        if (sc.scrollTop === last) stuck++; else stuck = 0;
        last = sc.scrollTop;
        if (sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4) {
          await sleep(400);
          absorb(collectVisibleSnapshotPieces(seenIds));
          break;
        }
        if (stuck > 8) break;
      }
    }

    // 行去重（同 id 只留一条；同文案相邻去重）
    const lines = [];
    const seenLineId = new Set();
    let prevText = '';
    for (const ln of allLines) {
      if (ln.id && seenLineId.has(ln.id)) continue;
      if (ln.id) seenLineId.add(ln.id);
      if (!ln.text || ln.text === prevText) continue;
      lines.push(ln);
      prevText = ln.text;
    }

    // 样式去重（含斜体/下划/底色/块级）
    const styles = [];
    const seenSt = new Set();
    for (const st of allStyles) {
      const k = [st.text, st.color, st.bg, st.bold ? 1 : 0, st.italic ? 1 : 0,
        st.underline ? 1 : 0, st.strike ? 1 : 0, st.code ? 1 : 0, st.link ? 1 : 0, st.block || ''].join('|');
      if (seenSt.has(k)) continue;
      seenSt.add(k);
      styles.push(st);
      if (styles.length >= 400) break;
    }

    const plain = lines.map(l => l.text).join('\n');
    const styleAtoms = SF ? SF.atomsFromStyleSamples(styles) : [];
    return {
      lines,
      styles,
      styleAtoms,
      plain,
      counts: {
        lines: lines.length,
        chars: plain.replace(/\s/g, '').length,
        tables,
        images,
        codes,
        styles: styles.length
      }
    };
  }

  function multisetDiff(srcArr, destArr) {
    const bag = new Map();
    for (const t of destArr) {
      const k = normLine(t);
      if (!k) continue;
      bag.set(k, (bag.get(k) || 0) + 1);
    }
    const missing = [];
    for (const t of srcArr) {
      const k = normLine(t);
      if (!k || k.length < 2) continue;
      const n = bag.get(k) || 0;
      if (n <= 0) missing.push(k);
      else bag.set(k, n - 1);
    }
    const extra = [];
    for (const [k, n] of bag) {
      for (let i = 0; i < n; i++) extra.push(k);
    }
    return { missing, extra };
  }

  function diffSnapshots(src, dest) {
    const srcLines = (src.lines || []).map(l => l.text);
    const destLines = (dest.lines || []).map(l => l.text);
    const textDiff = multisetDiff(srcLines, destLines);
    const sc = src.counts || {}, dc = dest.counts || {};

    // ① 总字数（内容完整性第一信号）
    const chars = charRetention(sc.chars || 0, dc.chars || 0);

    // ② 样式抽样（内容 OK 后再看）
    const styleMismatches = [];
    const destStyles = dest.styles || [];
    for (const st of (src.styles || [])) {
      if (!st.text || st.text.length < 2) continue;
      const hit = destStyles.find(d =>
        d.text === st.text
        || (d.text && (d.text.indexOf(st.text) >= 0 || st.text.indexOf(d.text) >= 0))
      );
      if (!hit) {
        const destPlain = dest.plain || destLines.join('\n');
        if (destPlain.indexOf(st.text) < 0
          && !textDiff.missing.some(m => m === st.text || m.indexOf(st.text) >= 0 || st.text.indexOf(m) >= 0)) {
          styleMismatches.push({
            text: st.text,
            issue: '带样式原文未找到',
            srcColor: st.colorRaw || st.color || '',
            destColor: ''
          });
        }
        continue;
      }
      if (st.color && hit.color && st.color !== hit.color) {
        styleMismatches.push({
          text: st.text,
          srcColor: st.colorRaw || st.color,
          destColor: hit.colorRaw || hit.color,
          issue: '颜色不一致'
        });
      }
      if (st.bold && !hit.bold) {
        styleMismatches.push({
          text: st.text,
          issue: '加粗丢失',
          srcColor: st.colorRaw || '',
          destColor: hit.colorRaw || ''
        });
      }
    }

    const countWarn = [];
    if ((sc.tables || 0) !== (dc.tables || 0)) {
      countWarn.push('表格数：源 ' + (sc.tables || 0) + ' → 目标 ' + (dc.tables || 0));
    }
    if ((sc.codes || 0) !== (dc.codes || 0)) {
      countWarn.push('代码块数：源 ' + (sc.codes || 0) + ' → 目标 ' + (dc.codes || 0));
    }
    if ((sc.images || 0) > 0 && Math.abs((sc.images || 0) - (dc.images || 0)) > Math.max(1, Math.floor((sc.images || 0) * 0.15))) {
      countWarn.push('图片数：源 ' + (sc.images || 0) + ' → 目标 ' + (dc.images || 0));
    }
    if (!chars.ok) {
      countWarn.unshift(chars.line + '（低于 ' + Math.round(CHAR_RATIO_WARN * 100) + '% 保留率）');
    }

    const missing = textDiff.missing;
    const extra = textDiff.extra;
    // 内容完整：总字数达标 + 无缺失文本行（多余行通常是导入噪点，不单独判失败）
    const contentOk = chars.ok && missing.length === 0;
    const styleOk = styleMismatches.length === 0;
    const identical = contentOk && styleOk && extra.length === 0 && countWarn.filter(w => w.indexOf('总字数') < 0).length === 0;

    let summary;
    if (identical) {
      summary = '自动对比：总字数一致，文本与抽样样式均未发现差异';
    } else if (!contentOk) {
      summary = '内容不完整：' + chars.line
        + (missing.length ? '；另有缺失文本 ' + missing.length + ' 条' : '');
    } else if (!styleOk) {
      summary = '内容字数 OK，但样式有差异 ' + styleMismatches.length + ' 处';
    } else {
      summary = '自动对比：缺失文本 ' + missing.length + ' 条，多余 ' + extra.length + ' 条'
        + (countWarn.length ? '，统计告警 ' + countWarn.length + ' 项' : '');
    }

    return {
      identical,
      contentOk,
      styleOk,
      chars,
      missing,
      extra,
      styleMismatches,
      countWarn,
      srcCounts: sc,
      destCounts: dc,
      summary
    };
  }

  function formatDiffReport(diff) {
    if (!diff) return '未生成对比报告';
    const lines = [];
    // 总字数永远放第一行，方便一眼判断有没有丢字
    if (diff.chars && diff.chars.line) lines.push(diff.chars.line);
    else {
      lines.push('总字数：源 ' + ((diff.srcCounts && diff.srcCounts.chars) || 0)
        + ' → 目标 ' + ((diff.destCounts && diff.destCounts.chars) || 0));
    }
    lines.push(diff.summary);
    lines.push('源明细：' + ((diff.srcCounts && diff.srcCounts.chars) || 0) + ' 字 / '
      + ((diff.srcCounts && diff.srcCounts.lines) || 0) + ' 行 / 表 '
      + ((diff.srcCounts && diff.srcCounts.tables) || 0) + ' / 图 '
      + ((diff.srcCounts && diff.srcCounts.images) || 0) + ' / 代码块 '
      + ((diff.srcCounts && diff.srcCounts.codes) || 0));
    lines.push('目标明细：' + ((diff.destCounts && diff.destCounts.chars) || 0) + ' 字 / '
      + ((diff.destCounts && diff.destCounts.lines) || 0) + ' 行 / 表 '
      + ((diff.destCounts && diff.destCounts.tables) || 0) + ' / 图 '
      + ((diff.destCounts && diff.destCounts.images) || 0) + ' / 代码块 '
      + ((diff.destCounts && diff.destCounts.codes) || 0));
    (diff.countWarn || []).forEach(w => {
      if (diff.chars && diff.chars.line && w.indexOf('总字数') === 0) return; // 已在首行
      lines.push('⚠ ' + w);
    });
    if (diff.missing && diff.missing.length) {
      lines.push('—— 目标缺失的原文（最多 30 条）——');
      diff.missing.slice(0, 30).forEach((t, i) => lines.push((i + 1) + '. ' + t.slice(0, 120)));
      if (diff.missing.length > 30) lines.push('…另有 ' + (diff.missing.length - 30) + ' 条缺失');
    }
    if (diff.extra && diff.extra.length) {
      lines.push('—— 目标多出的内容（最多 15 条）——');
      diff.extra.slice(0, 15).forEach((t, i) => lines.push((i + 1) + '. ' + t.slice(0, 120)));
    }
    if (diff.styleMismatches && diff.styleMismatches.length) {
      lines.push('—— 样式不一致（最多 20 条）——');
      diff.styleMismatches.slice(0, 20).forEach((s, i) => {
        lines.push((i + 1) + '. [' + s.issue + '] 「' + s.text + '」'
          + (s.srcColor ? ' 源色=' + s.srcColor : '')
          + (s.destColor ? ' 目标色=' + s.destColor : ''));
      });
    }
    if (diff.contentOk && diff.styleOk) {
      lines.push('内容与抽样样式均通过；若肉眼仍有细微差别，把位置发我继续加强。');
    } else if (!diff.contentOk) {
      lines.push('请先根据「缺失原文」修采集/导入；内容齐了再盯样式。');
    }
    return lines.join('\n');
  }

  /* 分片(Range)下载 + 每片重试：弱网/代理掐连接也能续着下完 */
  async function fetchMediaBytes(url, onProgress, label) {
    const CHUNK = 2 * 1024 * 1024;
    const tryFetch = async (headers) => {
      let last = null;
      for (let a = 1; a <= 4; a++) {
        try { return await fetchWithTimeout(url, { credentials: 'include', headers }, 180000); }
        catch (e) { last = e; if (a < 4) await sleep(1200 * a); }
      }
      throw last || new Error('网络错误');
    };
    let r = await tryFetch({ Range: 'bytes=0-1048575' });
    if (r.status !== 200 && r.status !== 206) throw new Error('HTTP ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const first = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200) return { ct, bytes: first };            // 服务端不支持 Range
    const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
    const total = m ? parseInt(m[1], 10) : 0;
    if (total && total > MAX_MEDIA_BYTES) {
      await r.arrayBuffer().catch(() => { });
      throw new Error('素材 ' + (total / 1048576).toFixed(0) + 'MB 超过上限（' + (MAX_MEDIA_BYTES / 1048576) + 'MB），已跳过');
    }
    if (!total || first.length >= total) return { ct, bytes: first };
    const out = new Uint8Array(total);
    out.set(first.subarray(0, total), 0);
    let off = Math.min(first.length, total);
    while (off < total) {
      const end = Math.min(total - 1, off + CHUNK - 1);
      const rr = await tryFetch({ Range: 'bytes=' + off + '-' + end });
      if (rr.status !== 200 && rr.status !== 206) throw new Error('HTTP ' + rr.status + ' @' + off);
      const part = new Uint8Array(await rr.arrayBuffer());
      if (!part.length) throw new Error('空分片 @' + off);
      const n = Math.min(part.length, total - off);
      out.set(part.subarray(0, n), off);
      off += n;
      if (label) onProgress && onProgress(label + ' ' + Math.round(off / total * 100) + '%');
    }
    return { ct, bytes: out };
  }

  /* 把字节上传到用户自己的云空间根目录（mount_point=explorer），返回 file_token */
  async function uploadToDrive(bytes, name, onProgress) {
    const H = () => ({ 'Request-Id': randId(), 'X-Request-Source': REQ_SOURCE });
    const blockSize = 4194304;
    let pj = null, msg = '';
    for (let attempt = 1; attempt <= 3 && !pj; attempt++) {
      try {
        const H1 = H();
        const pr = await fetchWithTimeout('/space/api/box/upload/prepare/', {
          method: 'POST', credentials: 'include',
          headers: { ...H1, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mount_node_token: '', mount_point: 'explorer', name, size: bytes.length })
        }, 60000);
        const j = await pr.json();
        if (j && j.code === 0 && j.data && j.data.upload_id) pj = { data: j.data, H1 };
        else msg = 'HTTP ' + pr.status + ' ' + ((j && j.msg) || '');
      } catch (e) { msg = e.message; }
      if (!pj && attempt < 3) await sleep(2000 * attempt);
    }
    if (!pj) throw new Error('云空间上传初始化失败：' + msg);
    const uid = pj.data.upload_id, bs = pj.data.block_size || blockSize, nb = pj.data.num_blocks || Math.ceil(bytes.length / bs);
    for (let i = 0; i < nb; i++) {
      const blk = bytes.subarray(i * bs, Math.min(bytes.length, (i + 1) * bs));
      let ok = false, last = '';
      for (let a = 1; a <= 3 && !ok; a++) {
        try {
          const r = await fetchWithTimeout('/space/api/box/stream/upload/merge_block/?upload_id=' + uid, {
            method: 'POST', credentials: 'include',
            headers: { ...pj.H1, 'Content-Type': 'application/octet-stream', 'x-seq-list': String(i), 'x-block-list-checksum': String(adler32(blk)), 'x-block-origin-size': String(bs) },
            body: blk
          }, 180000);
          const t = await r.text();
          if (r.status === 200 && t.indexOf('"code":0') >= 0) ok = true; else last = r.status + ' ' + t.slice(0, 60);
        } catch (e) { last = e.message; }
        if (!ok && a < 3) await sleep(2000 * a);
      }
      if (!ok) throw new Error('云空间上传分块失败（' + (i + 1) + '/' + nb + '）：' + last);
      onProgress && onProgress('上传到云空间 ' + (i + 1) + '/' + nb + '…');
    }
    const fr = await fetchWithTimeout('/space/api/box/upload/finish/', {
      method: 'POST', credentials: 'include',
      headers: { ...pj.H1, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: uid, num_blocks: nb })
    }, 60000);
    const fj = await fr.json();
    if (!fj || fj.code !== 0 || !fj.data || !fj.data.file_token) throw new Error('云空间上传完成失败：' + ((fj && fj.msg) || fr.status));
    return fj.data.file_token;
  }

  /* 素材块：文本内联；视频/PDF/其它附件上传到用户云空间并保留可点链接 */
  async function resolveMediaBlocks(html, mediaMap, onProgress) {
    // DOM 路径 media id 是 block-id（字母数字），不能只认 \\d+
    const ids = HN
      ? HN.listMediaPlaceholderIds(html)
      : [...new Set([...html.matchAll(/data-fxfer-media=["']([A-Za-z0-9_-]+)["']/g)].map(x => x[1]))];
    const uploadedVideos = [];
    if (!ids.length) return { html, videos: uploadedVideos };
    let i = 0;
    for (const id of ids) {
      i++;
      const m = mediaMap.get(id) || mediaMap.get(String(id));
      if (!m) {
        html = HN ? HN.replaceMediaPlaceholder(html, id, '')
          : html.split('<div data-fxfer-media="' + id + '"></div>').join('');
        continue;
      }
      const previewUrl = '/space/api/box/stream/download/preview/' + m.token + '/?preview_type=16';
      const allUrl = '/space/api/box/stream/download/all/' + m.token + '/';
      const originFileUrl = absolutizeHref('/file/' + m.token);
      let block = '';
      onProgress && onProgress('读取素材 ' + i + '/' + ids.length + '…', 42);
      try {
        let dl = null;
        let lastErr = null;
        for (const u of [allUrl, previewUrl]) {
          try {
            dl = await fetchMediaBytes(u, (t, p) => onProgress && onProgress(t, 46),
              '下载' + (/\.(mp4|mov|webm|pdf)$/i.test(m.name) ? (/\.pdf$/i.test(m.name) ? 'PDF' : '视频') : '素材'));
            if (dl && dl.bytes && dl.bytes.length) break;
          } catch (e) { lastErr = e; dl = null; }
        }
        if (!dl || !dl.bytes || !dl.bytes.length) throw (lastErr || new Error('空文件'));
        const ct = dl.ct, bytes = dl.bytes;
        const isText = /^text\/|json|xml|csv|javascript|x-markdown/.test(ct) || /\.(txt|md|csv|json|log|srt|yaml|yml|html?|xml)$/i.test(m.name);
        const isVideo = /^video\//.test(ct) || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(m.name);
        const isPdf = /pdf/i.test(ct) || /\.pdf$/i.test(m.name);
        if (isText && bytes.length < 2 * 1024 * 1024) {
          const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          block = '<p><b>【文件】' + esc(m.name) + '</b></p><pre><code>' + esc(txt) + '</code></pre>';
        } else if (isVideo) {
          if (bytes.length > 200 * 1024 * 1024) throw new Error('视频超过 200MB，已跳过');
          onProgress && onProgress('保存视频到你的云空间（' + (bytes.length / 1048576).toFixed(1) + 'MB）…', 46);
          const vname = /\.[a-z0-9]{2,5}$/i.test(m.fileName) ? m.fileName : m.fileName + '.mp4';
          const ft = await uploadToDrive(bytes, vname, (t) => onProgress && onProgress(t, 47));
          uploadedVideos.push({ fileToken: ft, name: m.name });
          block = '<p>【视频】<a href="' + location.origin + '/file/' + ft + '">' + esc(m.name) + '</a>（'
            + (bytes.length / 1048576).toFixed(1) + 'MB，已保存到你的云空间并会尝试插入本文档）</p>';
        } else {
          // PDF / 其它附件：上传到自己的云空间，保留可下载链接（以前直接丢弃）
          if (bytes.length > MAX_MEDIA_BYTES) throw new Error('附件超过上限，已跳过');
          onProgress && onProgress('保存附件到你的云空间（' + (bytes.length / 1048576).toFixed(1) + 'MB）…', 46);
          let fname = m.fileName || m.name || '附件';
          if (isPdf && !/\.pdf$/i.test(fname)) fname += '.pdf';
          if (!/\.[a-z0-9]{2,5}$/i.test(fname)) fname += '.bin';
          const ft = await uploadToDrive(bytes, fname, (t) => onProgress && onProgress(t, 47));
          const href = location.origin + '/file/' + ft;
          const kind = isPdf ? 'PDF' : '附件';
          block = '<p>【' + kind + '】<a href="' + href + '">' + esc(m.name) + '</a>（'
            + (bytes.length / 1048576).toFixed(1) + 'MB，已保存到你的云空间）</p>';
        }
      } catch (e) {
        // 下载失败仍尽量保留可跳转原链 /file/token
        block = '<p>【附件】<a href="' + esc(originFileUrl) + '">' + esc(m.name) + '</a>'
          + '（未能复制文件内容：' + esc(e && e.message ? e.message : e)
          + '；已保留源文件链接）</p>';
      }
      html = HN ? HN.replaceMediaPlaceholder(html, id, block)
        : html.split('<div data-fxfer-media="' + id + '"></div>').join(block);
    }
    return { html, videos: uploadedVideos };
  }

  const isDocUrl = () => /\/(wiki|docx)\//.test(location.pathname);
  const getScroller = () => document.querySelector(SCROLL_SEL);

  /* ---------------- 云空间文件夹（我的空间） ---------------- */

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([key], (r) => resolve((r && r[key]) || null));
      } catch (e) { resolve(null); }
    });
  }
  function storageSet(key, val) {
    return new Promise((resolve) => {
      try { chrome.storage.local.set({ [key]: val }, () => resolve()); }
      catch (e) { resolve(); }
    });
  }

  async function driveFetchJson(path) {
    const r = await fetchWithTimeout('/space/api/explorer/v3/' + path, {
      method: 'GET', credentials: 'include'
    }, 30000);
    const j = await r.json();
    if (!j || j.code !== 0) {
      throw new Error((j && j.msg) || ('HTTP ' + r.status));
    }
    return j.data || {};
  }

  async function driveListAll(path, extra) {
    const out = [];
    const seen = new Set();
    let label = '';
    for (let page = 0; page < 40; page++) {
      const q = 'length=50' + (extra || '') + (label ? '&last_label=' + encodeURIComponent(label) : '');
      const data = await driveFetchJson(path + '?' + q);
      const nodes = (data.entities && data.entities.nodes) || {};
      for (const tok of (data.node_list || [])) {
        if (nodes[tok]) out.push(nodes[tok]);
      }
      if (!data.has_more) break;
      const next = String(data.last_label || '');
      if (!next || next === label || seen.has(next)) break;
      seen.add(next);
      label = next;
    }
    return out;
  }

  function isDriveFolder(n) {
    return n && (n.type === OBJ_TYPE_FOLDER || n.type === 4);
  }

  async function listFoldersIn(parentToken) {
    let nodes;
    if (!parentToken) {
      nodes = await driveListAll('my_space/folder/', '');
    } else {
      nodes = await driveListAll('children/list/', '&token=' + encodeURIComponent(parentToken));
    }
    return nodes
      .filter(isDriveFolder)
      .map(n => ({
        token: n.token || n.obj_token,
        name: n.name || '未命名文件夹',
        type: n.type
      }))
      .filter(f => f.token)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  }

  function docTokenFromUrl(url) {
    const m = String(url || '').match(/\/docx\/([A-Za-z0-9]+)/);
    return m ? m[1] : '';
  }

  async function moveDocxToFolder(docToken, folderToken) {
    if (!docToken || !folderToken) return { ok: true, skipped: true };
    const csrf = await readCookie('_csrf_token');
    const headers = {
      'Content-Type': 'application/json',
      'X-Request-Source': REQ_SOURCE
    };
    if (csrf) {
      headers['X-CSRFToken'] = csrf;
      headers['x-csrftoken'] = csrf;
    }
    const attempts = [
      {
        url: '/space/api/explorer/v2/move/',
        body: {
          objs: [{ token: docToken, type: OBJ_TYPE_DOCX }],
          dest: { token: folderToken, type: OBJ_TYPE_FOLDER }
        }
      },
      {
        url: '/space/api/explorer/v2/obj/move/',
        body: {
          obj_list: [{ obj_token: docToken, obj_type: OBJ_TYPE_DOCX }],
          dst_parent_token: folderToken
        }
      },
      {
        url: '/space/api/box/service/move/',
        body: {
          obj_token: docToken,
          obj_type: OBJ_TYPE_DOCX,
          dest_parent_token: folderToken
        }
      },
      {
        url: '/space/api/explorer/v3/move/',
        body: {
          nodes: [{ token: docToken, type: OBJ_TYPE_DOCX }],
          destination: { token: folderToken, type: OBJ_TYPE_FOLDER }
        }
      }
    ];
    const formPairs = [
      ['src_token', 'dest_token'],
      ['token', 'dest_token'],
      ['obj_token', 'dest_token']
    ];
    for (const [srcKey, destKey] of formPairs) {
      const body = new URLSearchParams();
      body.set(srcKey, docToken);
      body.set(destKey, folderToken);
      body.set('type', String(OBJ_TYPE_DOCX));
      attempts.unshift({
        url: '/space/api/explorer/v2/move/',
        form: body.toString()
      });
    }
    let lastErr = '';
    for (const a of attempts) {
      try {
        const reqHeaders = Object.assign({}, headers);
        let payload;
        if (a.form) {
          reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded';
          payload = a.form;
        } else {
          payload = JSON.stringify(a.body);
        }
        const r = await fetchWithTimeout(a.url, {
          method: 'POST', credentials: 'include', headers: reqHeaders,
          body: payload
        }, 30000);
        const t = await r.text();
        let j = null;
        try { j = JSON.parse(t); } catch (e) { }
        if (j && j.code === 0) return { ok: true };
        lastErr = (j && (j.msg || j.code)) ? String(j.msg || j.code) : ('HTTP ' + r.status);
      } catch (e) {
        lastErr = e && e.message ? e.message : String(e);
      }
    }
    return { ok: false, error: lastErr || '移动失败' };
  }

  /* ---------------- UI ---------------- */

  let btnEl = null;
  let panelEl = null;
  let running = false;

  function ensureButton() {
    if (!btnEl) {
      btnEl = document.createElement('div');
      btnEl.className = 'fxfer-btn';
      btnEl.textContent = '⬇ 转存此文档';
      btnEl.addEventListener('click', onButtonClick);
      document.documentElement.appendChild(btnEl);
    }
    const ok = isDocUrl();
    btnEl.style.display = ok ? 'flex' : 'none';
    if (!ok) hidePanel();
  }

  function hidePanel() { if (panelEl) panelEl.remove(); panelEl = null; }

  function openPanel(mode) {
    hidePanel();
    panelEl = document.createElement('div');
    panelEl.className = 'fxfer-panel';
    const showCancel = mode !== 'pick';
    panelEl.innerHTML = `
      <div class="fxfer-head">
        <span class="fxfer-title">转存到我的飞书 <small class="fxfer-ver">v${EXT_VERSION}</small></span>
        ${showCancel ? '<span class="fxfer-cancel" title="中止本次转存">中止</span>' : ''}
        <span class="fxfer-close" title="收起">×</span>
      </div>
      <div class="fxfer-pick" style="display:none"></div>
      <div class="fxfer-progress-wrap">
        <div class="fxfer-status">准备中…</div>
        <div class="fxfer-bar"><div class="fxfer-bar-inner"></div></div>
        <div class="fxfer-detail"></div>
        <div class="fxfer-result"></div>
      </div>`;
    panelEl.querySelector('.fxfer-close').addEventListener('click', hidePanel);
    const cancelBtn = panelEl.querySelector('.fxfer-cancel');
    if (cancelBtn) cancelBtn.addEventListener('click', () => { window.__fxferAbort = true; });
    document.documentElement.appendChild(panelEl);
    return {
      el: panelEl,
      status(t, pct) {
        const s = panelEl.querySelector('.fxfer-status');
        if (typeof t === 'string') s.textContent = t;
        if (typeof pct === 'number') {
          panelEl.querySelector('.fxfer-bar-inner').style.width = Math.max(0, Math.min(100, pct)) + '%';
        }
      },
      detail(t) { panelEl.querySelector('.fxfer-detail').textContent = t || ''; },
      result(html) {
        panelEl.querySelector('.fxfer-result').innerHTML = html || '';
      },
      showPick() {
        panelEl.querySelector('.fxfer-pick').style.display = 'block';
        panelEl.querySelector('.fxfer-progress-wrap').style.display = 'none';
      },
      showProgress() {
        panelEl.querySelector('.fxfer-pick').style.display = 'none';
        panelEl.querySelector('.fxfer-progress-wrap').style.display = 'block';
      }
    };
  }

  function pathLabel(stack) {
    if (!stack.length) return '我的空间';
    return '我的空间 / ' + stack.map(x => x.name).join(' / ');
  }

  async function chooseFolder(ui) {
    ui.showPick();
    const pick = ui.el.querySelector('.fxfer-pick');
    const stack = []; // {token, name}
    let folders = [];
    let loading = false;

    const saved = await storageGet(STORAGE_FOLDER_KEY);

    const render = async () => {
      loading = true;
      pick.innerHTML = '<div class="fxfer-pick-hint">加载文件夹…</div>';
      try {
        const parent = stack.length ? stack[stack.length - 1].token : '';
        folders = await listFoldersIn(parent);
      } catch (e) {
        pick.innerHTML = '<div class="fxfer-pick-hint fxfer-pick-err">读取文件夹失败：'
          + esc(e && e.message ? e.message : e)
          + '<br>可直接存到「我的空间」根目录。</div>'
          + '<button type="button" class="fxfer-pick-go" data-act="start-root">存到我的空间并开始</button>';
        pick.querySelector('[data-act="start-root"]').onclick = () => finish({ token: '', path: '我的空间', mode: 'drive' });
        loading = false;
        return;
      }
      loading = false;

      const curPath = pathLabel(stack);
      const rows = folders.map((f, i) =>
        '<div class="fxfer-folder-row" data-i="' + i + '">'
        + '<span class="fxfer-folder-name">📁 ' + esc(f.name) + '</span>'
        + '<span class="fxfer-folder-enter" data-enter="' + i + '" title="进入">›</span>'
        + '</div>'
      ).join('') || '<div class="fxfer-pick-hint">此目录下没有子文件夹</div>';

      pick.innerHTML =
        '<div class="fxfer-pick-label">选择保存位置（原生复制保真）</div>'
        + '<div class="fxfer-pick-path" title="' + esc(curPath) + '">' + esc(curPath) + '</div>'
        + '<div class="fxfer-pick-nav">'
        + (stack.length
          ? '<button type="button" class="fxfer-pick-up" data-act="up">← 上级</button>'
          : '<span></span>')
        + '</div>'
        + '<div class="fxfer-folder-list">' + rows + '</div>'
        + '<button type="button" class="fxfer-pick-go" data-act="start">存到云盘并开始</button>'
        + '<details style="margin-top:10px"><summary class="fxfer-pick-hint" style="cursor:pointer">高级：存到知识库（可选）</summary>'
        + '<input class="fxfer-wiki-url" type="text" placeholder="粘贴你的知识库链接（可选）" style="width:100%;box-sizing:border-box;margin:6px 0;padding:6px 8px;border:1px solid #d0d3d6;border-radius:6px;font-size:12px">'
        + '<button type="button" class="fxfer-pick-go" data-act="wiki-url">用该知识库开始</button></details>';

      const up = pick.querySelector('[data-act="up"]');
      if (up) up.onclick = () => { stack.pop(); render(); };
      pick.querySelectorAll('.fxfer-folder-row').forEach(row => {
        row.addEventListener('click', (ev) => {
          if (ev.target && ev.target.getAttribute('data-enter') != null) return;
          const i = Number(row.getAttribute('data-i'));
          const f = folders[i];
          if (!f) return;
          finish({ token: f.token, path: pathLabel(stack.concat([f])), mode: 'drive' });
        });
      });
      pick.querySelectorAll('[data-enter]').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const i = Number(btn.getAttribute('data-enter'));
          const f = folders[i];
          if (!f || loading) return;
          stack.push(f);
          render();
        });
      });
      pick.querySelector('[data-act="start"]').onclick = () => {
        const cur = stack.length ? stack[stack.length - 1] : null;
        finish({ token: cur ? cur.token : '', path: pathLabel(stack), mode: 'drive' });
      };
      pick.querySelector('[data-act="wiki-url"]').onclick = async () => {
        const inp = pick.querySelector('.fxfer-wiki-url');
        const raw = (inp && inp.value || '').trim();
        if (!raw) { alert('请先粘贴你自己的知识库链接'); return; }
        pick.querySelector('[data-act="wiki-url"]').disabled = true;
        try {
          const wikiDest = await resolveWritableWikiFromUrl(raw);
          if (!wikiDest) {
            alert('无法解析该知识库链接，请确认是你有权限写入的 wiki 页面');
            return;
          }
          storageSet('fxfer_wiki_target', wikiDest);
          finish({
            mode: 'wiki',
            path: '知识库 ' + (wikiDest.title || wikiDest.spaceId),
            spaceId: wikiDest.spaceId,
            wikiToken: wikiDest.wikiToken,
            token: ''
          });
        } finally {
          const b = pick.querySelector('[data-act="wiki-url"]');
          if (b) b.disabled = false;
        }
      };
    };

    let resolveFn = null;
    let settled = false;
    const done = new Promise(r => { resolveFn = r; });
    function finish(sel) {
      if (settled) return;
      settled = true;
      if (sel) storageSet(STORAGE_FOLDER_KEY, { token: sel.token || '', path: sel.path || '我的空间' });
      resolveFn(sel);
    }

    const closeBtn = ui.el.querySelector('.fxfer-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', () => finish(null), { once: true });
    }

    await render();

    // 若上次选过子文件夹，且出现在当前列表，给个提示
    if (saved && saved.token && !stack.length) {
      const hit = folders.find(f => f.token === saved.token);
      if (hit) {
        const tip = document.createElement('div');
        tip.className = 'fxfer-pick-hint';
        tip.textContent = '上次：' + (saved.path || hit.name) + '（点文件夹直接选中，点 › 进入）';
        const list = pick.querySelector('.fxfer-folder-list');
        if (list) pick.insertBefore(tip, list);
      }
    }

    return done;
  }

  async function onButtonClick() {
    if (running) return;
    if (!isDocUrl()) { alert('此页面不是飞书文档'); return; }
    running = true;
    btnEl.classList.add('fxfer-disabled');
    const ui = openPanel('pick');
    try {
      const dest = await chooseFolder(ui);
      if (!dest || !panelEl) return; // 用户取消/关闭
      ui.showProgress();
      ui.status('准备转存…', 2);
      ui.detail('目标：' + (dest.path || '我的空间'));

      const res = await transfer({
        progress: (t, pct) => ui.status(t, pct),
        detail: (t) => ui.detail(t),
        destFolder: dest
      });
      const url = res.docUrl;
      let moveNote = '';
      if (res.nativePlaced) {
        moveNote = '位置：' + (dest.path || '我的空间') + '（原生复制已落盘）';
      } else if (dest.token) {
        ui.status('正在移动到所选文件夹…', 96);
        const tok = docTokenFromUrl(url);
        const mv = await moveDocxToFolder(tok, dest.token);
        if (mv.ok && !mv.skipped) {
          moveNote = '已移动到：' + dest.path;
        } else if (!mv.ok) {
          moveNote = '文档已生成，但自动移动失败（' + (mv.error || '') + '）。请在「我的空间」手动移动。';
        }
      } else {
        moveNote = '位置：我的空间';
      }

      const sourceNote = res.nativeCopy
        ? '方式：原生复制'
        : '方式：高保真重建（源文档禁止原生复制）';
      ui.status('✅ 转存成功', 100);
      ui.detail([sourceNote, moveNote].filter(Boolean).join('\n'));
      ui.result(`新文档：<a href="${url}" target="_blank">${url}</a>`);
      if (res.videos && res.videos.length) {
        ui.detail([sourceNote, moveNote, '正在打开新文档，把视频注入到文档里…'].filter(Boolean).join('\n'));
        try {
          chrome.runtime.sendMessage({ type: 'fxfer-open-and-insert', docUrl: url, items: res.videos }, () => void chrome.runtime.lastError);
        } catch (e) { }
      }
    } catch (e) {
      if (panelEl) {
        ui.showProgress();
        ui.status('❌ ' + (e && e.message ? e.message : '转存失败'), 0);
        ui.detail(e && e.detail ? e.detail : '');
      }
    } finally {
      running = false;
      if (btnEl) btnEl.classList.remove('fxfer-disabled');
    }
  }

  /* ---------------- 1. 滚动收集正文块 ---------------- */

  async function waitForImgs(maxMs = 2500) {
    const pend = [...document.querySelectorAll(`${SCROLL_SEL} [data-block-id] img`)]
      .filter(im => !im.complete && im.getAttribute('src'));
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && pend.some(im => !im.complete)) await sleep(200);
  }

  async function collectDoc(onProgress) {
    const sc = getScroller();
    if (!sc) { const e = new Error('未找到文档容器（.bear-web-x-container）'); e.detail = '请确认当前是文档正文页，且已加载完成。'; throw e; }

    onProgress('等待文档加载…', 5);
    let prevSh = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(1200);
      if (sc.scrollHeight === prevSh) { if (++stable >= 3) break; } else { stable = 0; prevSh = sc.scrollHeight; }
    }

    const store = new Map();
    const mediaSeen = new Set();
    const mediaMap = new Map();
    const tableOrder = new Map();                    // 表格块 → Y 顺序
    const cellStore = new Map();                     // 单元格 → {top,left,html}（跨快照累积）
    const cellOwner = new Map();                     // 单元格 → 所属表格 id
    const registerMedia = (mid, tok, name) => {
      if (mediaSeen.has(tok)) return false;
      mediaSeen.add(tok);
      mediaMap.set(String(mid), { token: tok, name: name, fileName: (name || 'file').replace(/[\\/:*?"<>|]/g, '_') });
      return true;
    };
    const orderY = new Map();                        // 块 → 文档内绝对 Y（用于按文档顺序合并）
    const imgDone = new Set();
    const specialIds = new Set();                    // 代码块等：不得被父块 outerHTML 覆盖掉
    const grab = async () => {
      for (const e of [...document.querySelectorAll(`${SCROLL_SEL} [data-block-id]`)]) {
      const id = e.getAttribute('data-block-id');
      const type = e.getAttribute('data-block-type');
      if (type === 'page') continue;                    // 页面容器：含标题栏/作者/评论等 UI，整块丢弃
      if (type === 'table_cell') continue;               // 单元格由"表格分支"统一处理，避免重复
      if (e.closest && e.closest('[data-block-type="table_cell"]')) continue;   // 单元格内的块同理
      const cls = (e.className || '').toString();
      const rawLen = (e.outerHTML || '').length;
      if (rawLen > 400000 && type !== 'code') continue; // 异常巨大的块（通常是整页容器）跳过
      if (!orderY.has(id)) {
        try { orderY.set(id, Math.round(e.getBoundingClientRect().top + sc.scrollTop)); } catch (err) { }
      }

      const isMedia = type === 'view' || type === 'file' || /docx-view-block|docx-file-block/.test(cls);
      if (isMedia) {
        const token = findMediaToken(e) || (e.getAttribute('data-record-id') || '');
        if (!token) continue;                          // 素材还没渲染出 token，等下一轮滚动
        const name = mediaName(e);
        if (!registerMedia(id, token, name)) continue;  // 同一素材只处理一次（含 view/file 两层）
        store.set(id, '<div data-fxfer-media="' + id + '"></div>');
        continue;
      }

      // 标题必须写成 h1–h6；保留标题内链接/样式，不能只丢纯文本
      const headingMatch = String(type || '').match(/^heading([1-9])$/i);
      if (headingMatch) {
        const level = Math.min(6, Math.max(1, Number(headingMatch[1])));
        const text = ownBlockText(e);
        const cleaned = cleanBlockHtml(e, registerMedia);
        const wrap = document.createElement('div');
        wrap.innerHTML = cleaned;
        const zone = wrap.querySelector('.zone-container, [data-zone-id], .text-block') || wrap;
        simplifyDocLinks(zone);
        // 标题红字：class 烘焙后确保 font+span color（parse_html 更稳）
        zone.querySelectorAll('span[color], font[color], span[style*="color"]').forEach(sp => {
          const hex = (sp.getAttribute('color') || '').trim()
            || ((sp.getAttribute('style') || '').match(/color\s*:\s*(#[0-9a-fA-F]{3,8}|rgb\([^)]+\))/i) || [])[1]
            || '';
          const nice = hex && /^#/.test(hex) ? hex.toLowerCase()
            : (hex ? rgbToCss(hex) : (HN ? HN.colorFromClassName(sp.className || '') : ''));
          if (!nice || isNearBlack(nice) || isNearWhite(nice)) return;
          sp.style.color = nice;
          try { sp.setAttribute('color', nice); } catch (err) { }
        });
        let inner = (zone.innerHTML || '').trim();
        if (!inner) inner = text ? esc(text) : '';
        if (!inner) continue;
        // 整段标题可见色（textHighlight-pink-text）
        try {
          const liveZone = e.querySelector('.zone-container, [data-zone-id]') || e;
          const leaf = liveZone.querySelector('span.textHighlight, span[data-leaf], span[data-string]') || liveZone;
          const clsHex = HN ? HN.colorFromClassName(leaf.className || '') : '';
          const cs = window.getComputedStyle(leaf);
          const liveColor = clsHex || (cs && cs.color) || '';
          if (liveColor && !isNearBlack(liveColor) && !isNearWhite(liveColor)
            && !/style\s*=\s*["'][^"']*color\s*:/i.test(inner) && !/\scolor\s*=\s*["']#/i.test(inner)) {
            const hex = /^#/.test(liveColor) ? liveColor.toLowerCase() : rgbToCss(liveColor);
            inner = HN ? HN.wrapColoredHtml(inner, hex)
              : ('<font color="' + hex + '"><span style="color:' + hex + '" color="' + hex + '">' + inner + '</span></font>');
          }
        } catch (err) { }
        const hTag = '<h' + level + '>' + inner + '</h' + level + '>';
        const prevH = store.get(id);
        if (!prevH || hTag.length > prevH.length) store.set(id, hTag);
        continue;
      }

      // 代码块：必须抽成 <pre><code>，不能用 ACE 空壳 outerHTML（会更长但导入后空白）
      const isCode = type === 'code' || /docx-code-block/.test(cls);
      if (isCode) {
        specialIds.add(String(id));
        const hCode = extractCodeBlockHtml(e);
        if (!hCode) continue; // 尚未滚入视口渲染完，等下一轮
        const prev = store.get(id);
        if (!prev || codeHtmlScore(hCode) >= codeHtmlScore(prev)) store.set(id, hCode);
        continue;
      }

      // 特殊块：结构难还原，先落文字/预览占位，保证「字不丢」
      if (FALLBACK_BLOCK_TYPES.test(type || '')) {
        specialIds.add(String(id));
        const fb = extractFallbackBlockHtml(e, type);
        const prev = store.get(id);
        if (!prev || fb.length > prev.length) store.set(id, fb);
        continue;
      }

      let h;
      const isTable = type === 'table' || /docx-table-block/.test(cls);
      if (isTable) {
        if (!tableOrder.has(id)) tableOrder.set(id, orderY.has(id) ? orderY.get(id) : 0);
        const cellNodes = [...e.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')];
        cellNodes.forEach((cell, domIndex) => {
          const cid = cell.getAttribute('data-block-id');
          const pos = cellStablePos(cell, e, sc);
          if (!cid || !pos) return;
          const html = extractCellInnerHtml(cell, registerMedia);
          const grid = readCellGridIndex(cell);
          const r = cell.getBoundingClientRect();
          cellOwner.set(cid, id);
          const prev = cellStore.get(cid);
          // 内容取更长的；坐标始终用本次稳定坐标刷新（避免视口坐标把表头排到最下）
          const next = {
            top: pos.top,
            left: pos.left,
            height: Math.round(r.height),
            row: grid.row,
            col: grid.col,
            domIndex,
            html: (prev && prev.html && prev.html.length > html.length) ? prev.html : html
          };
          cellStore.set(cid, next);
        });
        h = '<div data-fxfer-table="' + id + '"></div>';
      } else {
        h = cleanBlockHtml(e, registerMedia);
      }
      if (!imgDone.has(id) && /<img[^>]+src="(?!data:)/.test(h)) {
        h = await inlineBlockImages(e, h);
        if (!/<img[^>]+src="(?!data:)/.test(h)) imgDone.add(id);
      }
      const prev = store.get(id);
      if (!prev || h.length > prev.length) store.set(id, h);
      }
    };

    onProgress('采集正文（第 1 遍）…', 12);
    await grab();
    let lastTop = -1, stuck = 0, bottomStreak = 0;
    const t0 = Date.now();
    for (let i = 0; i < 420; i++) {
      if (window.__fxferAbort) throw new Error('已中止');
      if (Date.now() - t0 > 12 * 60 * 1000) break;          // 第一遍最多 12 分钟
      const prevSh = sc.scrollHeight;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(220, Math.floor(sc.clientHeight * 0.6)));
      await sleep(550);
      await scrollInnerContainers();
      await waitForImgs();
      await grab();
      onProgress('采集正文（滚动中）…', 12 + Math.min(28, 12 + (i / 600) * 28));
      const grew = sc.scrollHeight > prevSh;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (grew) { bottomStreak = 0; } else if (atBottom) { bottomStreak++; }
      if (sc.scrollTop === lastTop && !grew) stuck++; else stuck = 0;
      lastTop = sc.scrollTop;
      if (bottomStreak >= 4) { await sleep(800); await waitForImgs(); await grab(); break; }
      if (stuck > 14) break;
    }

    onProgress('补漏（第 2 遍）…', 42);
    sc.scrollTop = 0;
    await sleep(600);
    let b2 = 0;
    const t1 = Date.now();
    for (let i = 0; i < 320; i++) {
      if (window.__fxferAbort) throw new Error('已中止');
      if (Date.now() - t1 > 8 * 60 * 1000) break;            // 第二遍最多 8 分钟
      const prevSh2 = sc.scrollHeight;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(180, Math.floor(sc.clientHeight * 0.4)));
      await sleep(700);
      await scrollInnerContainers();
      await sleep(300);
      await waitForImgs();
      await grab();
      const grew2 = sc.scrollHeight > prevSh2;
      const atB2 = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (grew2) b2 = 0; else if (atB2) b2++;
      if (b2 >= 3) { await sleep(800); await waitForImgs(); await grab(); break; }
    }

    // 第三遍：逐个表格单元格强制滚入视口渲染（懒渲染的单元格/媒体块靠这一步补齐）
    onProgress('补漏（第 3 遍 · 单元格）…', 44);
    {
      const seenCells = new Set();
      const t2 = Date.now();
      for (let round = 0; round < 6; round++) {
        if (window.__fxferAbort) throw new Error('已中止');
        if (Date.now() - t2 > 4 * 60 * 1000) break;
        const cells = [...document.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')];
        let progressed = false;
        for (const cell of cells) {
          const cid = cell.getAttribute('data-block-id');
          if (!cid || seenCells.has(cid)) continue;
          seenCells.add(cid);
          progressed = true;
          try { cell.scrollIntoView({ block: 'center' }); } catch (e) { }
          await sleep(260);
          const ownerTbl = cell.closest('[data-block-type="table"], .docx-table-block');
          const tid = ownerTbl ? ownerTbl.getAttribute('data-block-id') : cellOwner.get(cid);
          if (tid) cellOwner.set(cid, tid);
          const pos = cellStablePos(cell, ownerTbl, sc);
          if (!pos) continue;
          const html = extractCellInnerHtml(cell, registerMedia);
          const grid = readCellGridIndex(cell);
          const r = cell.getBoundingClientRect();
          const prev = cellStore.get(cid);
          cellStore.set(cid, {
            top: pos.top,
            left: pos.left,
            height: Math.round(r.height),
            row: grid.row,
            col: grid.col,
            domIndex: prev && typeof prev.domIndex === 'number' ? prev.domIndex : 0,
            html: (prev && prev.html && prev.html.length > html.length) ? prev.html : html
          });
        }
        if (!progressed) break;
        await scrollInnerContainers();
        await sleep(400);
      }
    }

    const ids = [...store.keys()].sort((a, b) => {
      const ya = orderY.has(a) ? orderY.get(a) : 1e12;
      const yb = orderY.has(b) ? orderY.get(b) : 1e12;
      if (ya !== yb) return ya - yb;
      return (Number(a) || 0) - (Number(b) || 0);
    });
    const covered = new Set();
    let html = '';
    for (const id of ids) {
      const sid = String(id);
      // 代码块有独立抽取结果时，不被父块 HTML「吞掉」
      if (covered.has(sid) && !specialIds.has(sid)) continue;
      const h = store.get(sid);
      if (!h) continue;
      html += h;
      const re = /data-block-id="(\d+)"/g; let m;
      while ((m = re.exec(h))) {
        if (!specialIds.has(m[1])) covered.add(m[1]);
      }
      covered.add(sid);
    }
    // 组装前：尽量在同一布局下重测各表单元格相对表格的坐标，杜绝表头被排到最下
    onProgress('整理表格行列…', 45);
    for (const [tid] of tableOrder) {
      const tableEl = document.querySelector(`${SCROLL_SEL} [data-block-id="${tid}"]`);
      if (!tableEl) continue;
      try { tableEl.scrollIntoView({ block: 'nearest' }); } catch (e) { }
      await sleep(200);
      const cells = [...cellStore.entries()].filter(([cid]) => (cellOwner.get(cid) || tid) === tid);
      for (const [cid, prev] of cells) {
        const cell = document.querySelector(`[data-block-id="${cid}"]`);
        if (!cell) continue;
        const pos = cellStablePos(cell, tableEl, sc);
        if (!pos) continue;
        const grid = readCellGridIndex(cell);
        const r = cell.getBoundingClientRect();
        cellStore.set(cid, Object.assign({}, prev, {
          top: pos.top,
          left: pos.left,
          height: Math.round(r.height) || prev.height || 0,
          row: grid.row != null ? grid.row : prev.row,
          col: grid.col != null ? grid.col : prev.col
        }));
      }
    }

    // 用跨快照累积的单元格组装表格（稳定坐标 + 表头识别）
    const tableHtml = {};
    for (const [tid] of tableOrder) {
      const cells = [...cellStore.entries()].filter(([cid]) => (cellOwner.get(cid) || tid) === tid);
      if (!cells.length) { tableHtml[tid] = ''; continue; }
      const info = cells.map(([cid, c]) => ({
        cid,
        top: c.top,
        left: c.left,
        height: c.height || 0,
        row: c.row,
        col: c.col,
        domIndex: c.domIndex || 0,
        html: c.html || ''
      }));
      // B 方案：单元格内的素材占位挪到表格外（id 可能是字母数字 block-id）
      const mediaAfter = [];
      for (const it of info) {
        const ids = HN
          ? HN.listMediaPlaceholderIds(it.html)
          : [...String(it.html).matchAll(/data-fxfer-media=["']([A-Za-z0-9_-]+)["']/g)].map(x => x[1]);
        if (ids.length) {
          ids.forEach(id => mediaAfter.push(id));
          it.html = String(it.html).replace(/<div data-fxfer-media=["'][A-Za-z0-9_-]+["']><\/div>/g, '');
        }
      }
      let out = assembleTableFromCells(info);
      if (mediaAfter.length) {
        out += mediaAfter.map(id => '<div data-fxfer-media="' + id + '"></div>').join('');
      }
      tableHtml[tid] = out;
    }
    if (!html) { const e = new Error('未采集到文档内容'); e.detail = '页面可能尚未加载完成，请稍后重试。'; throw e; }
    for (const [tid, th] of Object.entries(tableHtml)) {
      html = html.split('<div data-fxfer-table="' + tid + '"></div>').join(th);
    }
    html = stripInvisible(html)
      .replace(/This document hasn't been mentioned by others yet\.?/gi, '')
      .replace(/本文档?尚未被他人提及。?/g, '');

    // 查漏补缺：原文块有字但 HTML 找不到 → 追加，优先保证不丢字
    onProgress('查漏补缺（防丢字）…', 46);
    const salvaged = salvageMissingTextIntoHtml(html);
    html = salvaged.html;
    if (salvaged.added) {
      onProgress('已补回疑似缺失段落 ' + salvaged.added + ' 处', 47);
    }

    const inventory = inventoryFromDom(document);
    // 若 DOM 扫到了代码块但 HTML 里没有，再强制补扫一次（防漏滚）
    if ((inventory.codes || []).length && inventoryFromHtml(html).codes.length < inventory.codes.length) {
      for (const e of document.querySelectorAll(`${SCROLL_SEL} [data-block-type="code"]`)) {
        const id = e.getAttribute('data-block-id');
        if (!id) continue;
        specialIds.add(String(id));
        const hCode = extractCodeBlockHtml(e);
        if (hCode && codeHtmlScore(hCode) > codeHtmlScore(store.get(id) || '')) store.set(id, hCode);
      }
      // 重建一次（保持顺序）
      html = '';
      const covered2 = new Set();
      for (const id of ids) {
        const sid = String(id);
        if (covered2.has(sid) && !specialIds.has(sid)) continue;
        // 新补上的代码块也可能不在 ids 里
        const h = store.get(sid);
        if (!h) continue;
        html += h;
        const re = /data-block-id="(\d+)"/g; let m;
        while ((m = re.exec(h))) { if (!specialIds.has(m[1])) covered2.add(m[1]); }
        covered2.add(sid);
      }
      for (const sid of specialIds) {
        if (covered2.has(sid)) continue;
        const h = store.get(sid);
        if (!h) continue;
        html += h;
        covered2.add(sid);
      }
      html = stripInvisible(html)
        .replace(/This document hasn't been mentioned by others yet\.?/gi, '')
        .replace(/本文档?尚未被他人提及。?/g, '');
      const salvaged2 = salvageMissingTextIntoHtml(html);
      html = salvaged2.html;
    }
    return { html, mediaMap, inventory, salvaged: salvaged.added || 0 };
  }

  /* ---------------- 2. 图片转 base64 内嵌 ---------------- */

  async function fetchAsDataURL(src, compressOpts) {
    const r = await fetch(src, src.startsWith('blob:') ? {} : { credentials: 'include' });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.skip = true; throw e; }
    const bl = await r.blob();
    if (!bl.size || bl.size > MAX_IMG_BYTES) { const e = new Error('图片大小超限(' + bl.size + ')'); e.skip = true; throw e; }
    if (bl.type && !/^image\//.test(bl.type) && !src.startsWith('blob:')) { const e = new Error('非图片类型 ' + bl.type); e.skip = true; throw e; }
    return await blobToEmbeddedDataURL(bl, compressOpts);
  }

  async function embedImages(html, onProgress) {
    const srcs = [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(x => x[1]))];
    const total = srcs.length;
    let ok = 0, fail = 0, i = 0;
    const map = {};
    for (const s of srcs) {
      i++;
      onProgress(`下载图片 ${i}/${total}…`, 45 + Math.round((i / Math.max(1, total)) * 25));
      if (s.startsWith('data:')) { map[s] = s; ok++; continue; }
      try {
        map[s] = await fetchAsDataURL(s);
        ok++;
      } catch (e1) {
        // 对 drive-stream 图片再试同源路径
        let done = false;
        if (s.includes('internal-api-drive-stream.feishu.cn')) {
          try { map[s] = await fetchAsDataURL(s.replace('https://internal-api-drive-stream.feishu.cn', '')); ok++; done = true; } catch (e2) { }
        }
        if (!done) {
          const tm = String(s).match(/\/download\/all\/([A-Za-z0-9]+)/);
          if (tm) {
            try {
              map[s] = await fetchAsDataURL('/space/api/box/stream/download/preview/' + tm[1] + '/?preview_type=16');
              ok++;
              done = true;
            } catch (e3) { }
          }
        }
        if (!done) { fail++; console.warn('[转存] 图片跳过:', s.slice(0, 80), e1.message); }
      }
    }
    let out = html;
    for (const [k, v] of Object.entries(map)) out = out.split('src="' + k + '"').join('src="' + v + '"');
    onProgress(`图片处理完成（成功 ${ok} / 跳过 ${fail}）`, 72);
    return { html: out, ok, fail };
  }

  function dataURLToBlob(dataUrl) {
    const m = String(dataUrl).match(/^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i);
    if (!m) throw new Error('非 base64 图片');
    const bin = atob(m[2]);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: m[1] || 'image/jpeg' });
  }

  function htmlByteLength(s) {
    return new TextEncoder().encode(s).length;
  }

  /* 文档体积超限时：按图从大到小再压；仍超限则把最大的几张换成占位，保证能转存 */
  async function shrinkEmbeddedHtml(html, targetBytes, onProgress) {
    const re = /src="(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)"/g;
    const found = [];
    let m;
    while ((m = re.exec(html))) found.push(m[1]);
    if (!found.length) return { html, shrunk: 0, dropped: 0 };

    const uniq = [];
    const seen = new Set();
    for (const f of found) {
      if (seen.has(f)) continue;
      seen.add(f);
      uniq.push(f);
    }
    uniq.sort((a, b) => b.length - a.length);

    let out = html;
    let shrunk = 0;
    let dropped = 0;
    const passes = [
      { maxDim: 1600, quality: 0.72, label: '二次压缩图片' },
      { maxDim: 1200, quality: 0.58, label: '强力压缩图片' },
      { maxDim: 900, quality: 0.45, label: '极限压缩图片' }
    ];

    for (const pass of passes) {
      if (htmlByteLength(out) <= targetBytes) break;
      onProgress && onProgress(pass.label + '以控制体积…', 71);
      for (let i = 0; i < uniq.length; i++) {
        if (htmlByteLength(out) <= targetBytes) break;
        const oldUrl = uniq[i];
        if (!out.includes(oldUrl)) continue;
        if (oldUrl.length < 80 * 1024) continue;
        try {
          const bl = dataURLToBlob(oldUrl);
          const c = await compressImageBlob(bl, pass.maxDim, pass.quality);
          if (!c) continue;
          const neu = await blobToDataURLRaw(c);
          if (!neu || neu.length >= oldUrl.length) continue;
          out = out.split(oldUrl).join(neu);
          uniq[i] = neu;
          shrunk++;
        } catch (e) { }
      }
    }

    while (htmlByteLength(out) > targetBytes) {
      const still = [];
      const re2 = /src="(data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)"/g;
      let mm;
      while ((mm = re2.exec(out))) still.push(mm[1]);
      if (!still.length) break;
      still.sort((a, b) => b.length - a.length);
      const victim = still[0];
      if (victim.length < 40 * 1024) break;
      const ph = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120">'
        + '<rect width="100%" height="100%" fill="#f5f5f5"/>'
        + '<text x="24" y="68" font-size="18" fill="#666">图片过大已跳过，可在源文档查看</text></svg>'
      );
      out = out.split(victim).join(ph);
      dropped++;
      onProgress && onProgress('体积仍偏大，已跳过 ' + dropped + ' 张大图…', 72);
    }

    return { html: out, shrunk, dropped };
  }

  /* ---------------- 3. 提交 + 轮询 ---------------- */

  function adler32(u8) {
    let a = 1, b = 0;
    for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }

  async function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;)\\s*' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* 分块上传：prepare → 逐块 merge_block(每块可独立重试) → finish → file_token */
  async function chunkedUpload(bytes, name, onProgress) {
    const requestId = randId();
    const H = { 'Request-Id': requestId, 'X-Request-Source': REQ_SOURCE };

    let pj = null, lastMsg = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const pr = await fetchWithTimeout('/space/api/box/upload/prepare/', {
          method: 'POST', credentials: 'include',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mount_node_token: '', mount_point: 'wiki_confluence', name, size: bytes.length })
        }, 60000);
        pj = await pr.json();
        if (pj && pj.code === 0 && pj.data && pj.data.upload_id) break;
        lastMsg = 'HTTP ' + pr.status + ' code=' + (pj && pj.code) + ' ' + ((pj && pj.msg) || '');
        pj = null;
      } catch (e) { lastMsg = e.message; }
      if (attempt < 3) await sleep(2000 * attempt);
    }
    if (!pj) { const e = new Error('初始化上传失败：' + lastMsg); e.detail = '请检查网络后重试'; throw e; }
    const uploadId = pj.data.upload_id;
    const blockSize = pj.data.block_size || 4194304;
    const numBlocks = pj.data.num_blocks || Math.ceil(bytes.length / blockSize);

    for (let i = 0; i < numBlocks; i++) {
      const blk = bytes.subarray(i * blockSize, Math.min(bytes.length, (i + 1) * blockSize));
      let done = false, lastE = '';
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          const r = await fetchWithTimeout('/space/api/box/stream/upload/merge_block/?upload_id=' + uploadId, {
            method: 'POST', credentials: 'include',
            headers: { ...H, 'Content-Type': 'application/octet-stream', 'x-seq-list': String(i), 'x-block-list-checksum': String(adler32(blk)), 'x-block-origin-size': String(blockSize) },
            body: blk
          }, 120000);
          const rj = await r.json();
          if (rj && rj.code === 0) done = true;
          else lastE = 'HTTP ' + r.status + ' ' + ((rj && rj.msg) || '');
        } catch (e) { lastE = e.message; }
        if (!done && attempt < 3) await sleep(2000 * attempt);
      }
      if (!done) {
        const e = new Error('分块上传失败（第 ' + (i + 1) + '/' + numBlocks + ' 块）：' + lastE);
        e.detail = '网络不稳定导致。可直接重试，会从当前进度继续。';
        throw e;
      }
      onProgress('上传分块 ' + (i + 1) + '/' + numBlocks + '…', 74 + Math.round(((i + 1) / numBlocks) * 12));
    }

    let fileToken = null, lastMsg2 = '';
    for (let attempt = 1; attempt <= 3 && !fileToken; attempt++) {
      try {
        const fr = await fetchWithTimeout('/space/api/box/upload/finish/', {
          method: 'POST', credentials: 'include',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_id: uploadId, num_blocks: numBlocks })
        }, 60000);
        const fj = await fr.json();
        if (fj && fj.code === 0 && fj.data && fj.data.file_token) fileToken = fj.data.file_token;
        else lastMsg2 = 'HTTP ' + fr.status + ' code=' + (fj && fj.code) + ' ' + ((fj && fj.msg) || '');
      } catch (e) { lastMsg2 = e.message; }
      if (!fileToken && attempt < 3) await sleep(2000 * attempt);
    }
    if (!fileToken) { const e = new Error('完成上传失败：' + lastMsg2); e.detail = '请重试'; throw e; }
    return fileToken;
  }

  async function submitParseHtml(fullHtml, title, onProgress) {
    const bytes = new TextEncoder().encode(fullHtml);
    if (bytes.length > MAX_HTML_BYTES) {
      const e = new Error('文档过大（' + (bytes.length / 1048576).toFixed(1) + 'MB），压缩后仍超限');
      e.detail = '已尽量压缩图片。可再删掉源文档中部分大图后重试。';
      throw e;
    }
    onProgress('上传文件（分块）…', 73);
    const fileToken = await chunkedUpload(bytes, title + '.html', onProgress);

    const fd = new FormData();
    fd.append('description', '');
    fd.append('cover', COVER);
    fd.append('docType', 'docx');
    fd.append('originUrl', location.href);
    fd.append('clipVersion', CLIP_VERSION);
    fd.append('lang', 'zh-CN');
    fd.append('fileToken', fileToken);
    fd.append('title', title);

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const headers = { 'X-Request-Source': REQ_SOURCE };
      try {
        const csrf = await readCookie('_csrf_token');
        if (attempt > 1 && csrf) headers['X-CSRFToken'] = csrf;
        const r = await fetchWithTimeout('/space/api/parser/wiki/parse_html/', {
          method: 'POST', credentials: 'include', headers, body: fd
        }, 60000);
        const t = await r.text();
        if (r.status === 403 && /csrf/i.test(t)) continue;
        let j = null;
        try { j = JSON.parse(t); } catch (e) { }
        if (j && j.ticket) return j.ticket;
        if ((r.status === 502 || r.status === 504 || r.status === 429) && attempt < 3) {
          lastErr = new Error('HTTP ' + r.status);
        } else {
          const e = new Error('提交转存失败：' + (j && j.msg ? j.msg : 'HTTP ' + r.status));
          e.detail = t.slice(0, 300);
          throw e;
        }
      } catch (e) {
        if (e && e.detail) throw e;
        lastErr = e;
      }
      if (attempt < 3) { onProgress && onProgress('网络波动，自动重试…', 88); await sleep(2000 * attempt); }
    }
    const e = new Error('提交失败：网络多次中断，请检查网络后重试');
    e.detail = String(lastErr && (lastErr.message || lastErr)).slice(0, 200);
    throw e;
  }
  async function pollResult(ticket, onProgress) {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      onProgress('等待飞书生成文档…', 88 + Math.min(10, i));
      const r = await fetch('/space/api/parser/wiki/clip/result?_r=' + Date.now() + '&ticket=' + ticket, { credentials: 'include' });
      const t = await r.text();
      if (!t || t.trim() === 'null' || t.trim() === '') continue;
      let j = null;
      try { j = JSON.parse(t); } catch (e) { throw new Error('结果解析失败：' + t.slice(0, 200)); }
      if (j.docUrl) return j.docUrl;
      throw new Error('转存未成功：' + (j.msg || j.status || t.slice(0, 200)));
    }
    throw new Error('等待超时：飞书生成文档时间过长，请稍后在「我的空间」查看是否已生成。');
  }

  /* ---------------- 飞书 JSON 辅助（文档数据回退用） ---------------- */

  async function feishuGetJson(url) {
    const r = await fetchWithTimeout(url, { method: 'GET', credentials: 'include' }, 20000);
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return null; }
  }

  async function feishuPostJson(url, body) {
    const csrf = await readCookie('_csrf_token');
    const headers = { 'Content-Type': 'application/json', 'X-Request-Source': REQ_SOURCE };
    if (csrf) { headers['X-CSRFToken'] = csrf; headers['x-csrftoken'] = csrf; }
    const r = await fetchWithTimeout(url, {
      method: 'POST', credentials: 'include', headers, body: JSON.stringify(body)
    }, 30000);
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return { code: r.status, msg: String(t || '').slice(0, 180) }; }
  }

  /** 云盘 clone：application/x-www-form-urlencoded */
  async function feishuPostForm(url, fields) {
    const csrf = await readCookie('_csrf_token');
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Request-Source': REQ_SOURCE
    };
    if (csrf) { headers['X-CSRFToken'] = csrf; headers['x-csrftoken'] = csrf; }
    const body = new URLSearchParams();
    Object.keys(fields).forEach((k) => {
      if (fields[k] === undefined || fields[k] === null) return;
      body.append(k, String(fields[k]));
    });
    const r = await fetchWithTimeout(url, {
      method: 'POST', credentials: 'include', headers, body: body.toString()
    }, 60000);
    const t = await r.text();
    try { return JSON.parse(t); } catch (e) { return { code: r.status, msg: String(t || '').slice(0, 180) }; }
  }

  function pickWikiNode(j) {
    if (!j || j.code !== 0) return null;
    const d = j.data || {};
    const node = d.node || d.wiki_node || d.entity || d;
    const objToken = node.obj_token || node.objToken || d.obj_token || '';
    const spaceId = node.space_id || node.spaceId || d.space_id || d.spaceId || '';
    const wikiToken = node.wiki_token || node.wikiToken || d.wiki_token || node.token || '';
    const objType = node.obj_type || node.objType || d.obj_type || 22;
    const parent = node.parent_wiki_token || node.parent_token || d.parent_wiki_token || '';
    if (!objToken && !spaceId && !wikiToken) return null;
    return {
      objToken, objType, spaceId: String(spaceId || ''), wikiToken, parent,
      title: node.title || d.title || ''
    };
  }

  async function fetchWikiNode(wikiToken) {
    if (!wikiToken) return null;
    const urls = [
      '/space/api/wiki/v2/tree/get_node/?wiki_token=' + encodeURIComponent(wikiToken),
      '/space/api/wiki/v2/tree/get_info/?wiki_token=' + encodeURIComponent(wikiToken),
      '/space/api/wiki/v2/tree/get_info/?token=' + encodeURIComponent(wikiToken)
    ];
    for (const u of urls) {
      const hit = pickWikiNode(await feishuGetJson(u));
      if (hit && (hit.objToken || hit.spaceId)) return hit;
    }
    return null;
  }

  /** 从知识库 URL 解析可写目标 spaceId + parent wiki token */
  async function resolveWritableWikiFromUrl(urlOrToken) {
    const s = String(urlOrToken || '').trim();
    if (!s) return null;
    let wikiToken = '';
    try {
      if (/^https?:\/\//i.test(s)) {
        const u = new URL(s);
        const m = u.pathname.match(/\/wiki\/([A-Za-z0-9]+)/);
        wikiToken = m ? m[1] : '';
      } else {
        wikiToken = s.replace(/^\//, '');
      }
    } catch (e) {
      wikiToken = s;
    }
    if (!wikiToken) return null;
    const info = await fetchWikiNode(wikiToken);
    if (!info || !info.spaceId) return null;
    return {
      spaceId: String(info.spaceId),
      wikiToken: String(info.parent || wikiToken),
      title: info.title || wikiToken,
      nodeToken: wikiToken
    };
  }

  async function resolveSourceObj() {
    const wiki = (location.pathname.match(/\/wiki\/([A-Za-z0-9]+)/) || [])[1] || '';
    const docx = (location.pathname.match(/\/docx\/([A-Za-z0-9]+)/) || [])[1] || '';
    if (wiki) {
      const info = await fetchWikiNode(wiki);
      if (info && info.objToken) return { token: info.objToken, type: Number(info.objType) || 22, wiki };
      if (docx) return { token: docx, type: 22, wiki };
    }
    if (docx) return { token: docx, type: 22, wiki: '' };
    return null;
  }

  /**
   * 预检「创建副本 / duplicate」权限（方案 A）。
   * 仅作提示；最终以 clone 接口为准（服务端才是真理）。
   */
  async function probeDuplicatePermission(source) {
    if (!source || !source.token) return { ok: null, reason: 'no-token' };
    const typ = Number(source.type) || OBJ_TYPE_DOCX;
    const bodies = [
      { token: source.token, type: typ },
      { obj_token: source.token, obj_type: typ },
      { tokens: [{ token: source.token, type: typ }] }
    ];
    const url = '/space/api/suite/permission/document/actions/state/';
    for (const body of bodies) {
      try {
        const j = await feishuPostJson(url, body);
        if (!j || (j.code !== 0 && j.code !== '0')) continue;
        const actions = (j.data && j.data.actions) || j.actions || {};
        const dup = actions.duplicate;
        const copy = actions.copy;
        if (dup === 0 || dup === '0' || dup === false) {
          return { ok: false, reason: 'duplicate=0', actions, raw: j };
        }
        if (dup === 1 || dup === '1' || dup === true) {
          return { ok: true, reason: 'duplicate=1', actions, raw: j };
        }
        if (copy === 0 || copy === '0') {
          return { ok: false, reason: 'copy=0', actions, raw: j };
        }
        if (typeof dup !== 'undefined' || typeof copy !== 'undefined') {
          return { ok: null, reason: 'unknown-actions', actions, raw: j };
        }
      } catch (e) { /* try next body */ }
    }
    return { ok: null, reason: 'probe-unavailable' };
  }

  function formatNativeFailDetail(nativeError) {
    const msg = String(nativeError || '未知原因');
    const forbidden = /Forbidden|禁止创建副本|禁止复制|NodePermFail|not allow|forbid|无权限|403/i.test(msg);
    let out = msg;
    if (forbidden) {
      out =
        '飞书服务端拒绝了「创建副本」（' + msg + '）。\n'
        + '这表示：源文档所有者关闭了复制权限，或当前账号无权复制。\n'
        + '在这种权限下，任何工具都无法做到「服务端级完全一致」的转存。\n\n'
        + '请你先在本页右上角「…」里看「创建副本」是否可用：\n'
        + '· 若灰掉/无此菜单 → 换一篇允许创建副本的文档验证插件；或请所有者开放复制。\n'
        + '· 若菜单可用 → 把完整报错发我（不应再是 Forbidden）。';
    } else {
      out = msg + '\n\n请确认：已登录飞书；目标选「我的空间」或子文件夹；源文档允许「创建副本」。';
    }
    return out;
  }

  /* ---------------- 文档数据重建（仅页面几乎采不到时使用；主路径仍是 DOM 采集） ---------------- */

  function transferBannerHtml() {
    const when = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = when.getFullYear() + '-' + pad(when.getMonth() + 1) + '-' + pad(when.getDate())
      + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes()) + ':' + pad(when.getSeconds());
    const url = location.href;
    return '<blockquote style="border-left:3px solid #3370ff;padding:8px 12px;background:#f5f8ff">'
      + '<p>原文链接：<a href="' + esc(url) + '">' + esc(url) + '</a></p>'
      + '<p>转存时间：' + esc(stamp) + '</p>'
      + '<p>本文档由飞书文档转存生成</p>'
      + '</blockquote>';
  }

  function unpackClientVars(j) {
    if (!j || (j.code !== 0 && j.code !== '0')) return null;
    const d = j.data || {};
    const bags = [d.collab_client_vars, d.clientvar, d.client_vars, d];
    for (const cv of bags) {
      if (!cv || typeof cv !== 'object') continue;
      let blockMap = cv.block_map || cv.blockMap || null;
      if (!blockMap && Array.isArray(cv.blocks)) {
        blockMap = {};
        cv.blocks.forEach(b => {
          const id = b && (b.id || b.block_id);
          if (id) blockMap[id] = b;
        });
      }
      if (blockMap && typeof blockMap === 'object' && Object.keys(blockMap).length) {
        return {
          blockMap,
          cursor: cv.cursor || d.cursor || '',
          nextCursors: cv.next_cursors != null ? cv.next_cursors : d.next_cursors,
          hasMore: !!(cv.has_more || d.has_more),
          skipBlocks: Array.isArray(cv.skip_blocks) ? cv.skip_blocks.map(String)
            : (Array.isArray(d.skip_blocks) ? d.skip_blocks.map(String) : []),
          sequence: Array.isArray(cv.block_sequence) ? cv.block_sequence.map(String)
            : (Array.isArray(d.block_sequence) ? d.block_sequence.map(String) : []),
          id: cv.id || d.id || ''
        };
      }
    }
    return null;
  }

  function firstCursorOf(nc) {
    if (typeof nc === 'string') return nc;
    if (Array.isArray(nc)) {
      for (const v of nc) if (typeof v === 'string' && v) return v;
      return '';
    }
    if (nc && typeof nc === 'object') {
      for (const v of Object.values(nc)) if (typeof v === 'string' && v) return v;
    }
    return '';
  }

  /* 翻页合并 / blockBody / childIds：委托 core/block-tree（含对象形 children） */
  function mergeBlockMap(into, add) {
    if (!BT) return;
    BT.mergeBlockMap(into, add);
  }

  function blockBody(raw) {
    return BT ? BT.blockBody(raw) : null;
  }

  function childIds(body) {
    return BT ? BT.childIds(body) : [];
  }

  function attrTruthy(v) {
    return v === true || v === 'true' || v === '1' || v === 1;
  }

  function linkHref(v) {
    if (!v) return '';
    if (typeof v === 'object') return v.href || v.url || '';
    const s = String(v);
    if (/^(https?:|mailto:|\/)/i.test(s)) return s;
    if (s.charAt(0) === '{') {
      try {
        const j = JSON.parse(s);
        if (j && (j.href || j.url)) return String(j.href || j.url);
      } catch (e) { }
    }
    return '';
  }

  function decodeAttribZone(attrStr, text, numToAttrib) {
    const src = String(text || '');
    const segments = [];
    const re = /(\*[\da-z]+(?:\*[\da-z]+)*)?(?:\|([\da-z]+))?\+([\da-z]+)/gi;
    let m;
    let pos = 0;
    let any = false;
    const spec = String(attrStr || '');
    while ((m = re.exec(spec))) {
      any = true;
      const len = parseInt(m[3], 36);
      if (!isFinite(len) || len < 0) continue;
      let slice = src.slice(pos, pos + len);
      pos += len;
      const attrs = {};
      if (m[1]) {
        m[1].split('*').filter(Boolean).forEach(id => {
          const pair = numToAttrib[String(parseInt(id, 36))] || numToAttrib[id];
          if (Array.isArray(pair) && pair.length >= 2) attrs[pair[0]] = pair[1];
        });
      }
      if (attrs.equation && !String(slice).trim()) slice = String(attrs.equation);
      segments.push({ text: slice, attrs });
    }
    if (!any) {
      if (src) segments.push({ text: src, attrs: {} });
    } else if (pos < src.length) {
      segments.push({ text: src.slice(pos), attrs: {} });
    }
    return segments;
  }

  function textFieldZones(textField) {
    if (textField == null) return [];
    if (typeof textField === 'string') return [{ attr: '', text: textField, numToAttrib: {} }];
    const apool = textField.apool || {};
    const numToAttrib = apool.numToAttrib || {};
    const iat = textField.initialAttributedTexts || textField;
    let texts = iat.text || iat.texts || '';
    let attribs = iat.attribs || '';
    if (typeof texts === 'string') texts = { '0': texts };
    if (typeof attribs === 'string') attribs = { '0': attribs };
    if (!texts || typeof texts !== 'object') return [];
    // 必须读全部分行 key（0/1/2…）。旧逻辑见 key'0' 就只取一行，代码块会大段丢字
    const keys = Object.keys(texts).sort((a, b) => Number(a) - Number(b));
    return keys.map(k => ({
      attr: attribs[k] || '',
      text: texts[k] || '',
      numToAttrib
    }));
  }

  function linesFromTextField(textField) {
    const zones = textFieldZones(textField);
    const lines = [];
    let cur = [];
    const pushLine = () => { lines.push(cur); cur = []; };
    // 飞书代码块常把每行放在 texts['0'|'1'|…]，且行尾不一定带 \n；
    // 旧逻辑只在字符串内的 \n 处分行，多 key 会被拼成一行 → 大段丢字/丢换行
    zones.forEach((z, zi) => {
      const segs = decodeAttribZone(z.attr, z.text, z.numToAttrib);
      segs.forEach(seg => {
        const parts = String(seg.text).split('\n');
        parts.forEach((part, i) => {
          if (part) cur.push({ text: part, attrs: seg.attrs || {} });
          if (i < parts.length - 1) pushLine();
        });
      });
      if (zones.length > 1 && zi < zones.length - 1) {
        if (cur.length) pushLine();
        // 行尾已带 \n 时 cur 已空，不再插空行
      }
    });
    if (cur.length || !lines.length) pushLine();
    return lines;
  }

  function plainFromTextField(textField) {
    return linesFromTextField(textField).map(line => line.map(s => s.text).join('')).join('\n');
  }

  /* 代码块可能挂在 body.text / body.code / body.code.text */
  function plainFromCodeBody(body) {
    if (!body) return '';
    const bags = [body.text, body.code];
    if (body.code && typeof body.code === 'object') {
      bags.push(body.code.text, body.code.content, body.code.value);
    }
    let best = '';
    for (const bag of bags) {
      if (bag == null || bag === '') continue;
      const plain = typeof bag === 'string' ? bag : plainFromTextField(bag);
      if (plain && plain.length > best.length) best = plain;
    }
    return best;
  }

  /**
   * 小学生手抄式：逐行、逐字核对。
   * 行在 HTML 里常被合并成段：只要源行文本（归一化后）出现在目标里就算命中。
   * 目标字数 ≥ 源字数且行都在 → 通过；真丢字才中止。
   */
  function charLineFidelity(srcPlain, destPlain) {
    const softNorm = (s) => String(s || '')
      .replace(/\r\n/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#(\d+);/g, (_, n) => {
        const c = Number(n);
        return (c > 0 && c < 0x110000) ? String.fromCodePoint(c) : '';
      })
      .replace(/\u00a0/g, ' ')
      .replace(/[—–―−﹣－]/g, '-')
      .replace(/＆/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const src = String(srcPlain || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    const dest = String(destPlain || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    const srcLines = src.split('\n');
    const destLines = dest.split('\n');
    const destHay = destLines.map(l => softNorm(l)).filter(Boolean);
    const destFlat = softNorm(dest);
    const destSet = new Set(destHay);
    const missingLines = [];
    srcLines.forEach((ln, i) => {
      const raw = ln.trim();
      if (raw.length < 1) return;
      const t = softNorm(raw);
      if (!t) return;
      if (destSet.has(t)) return;
      if (destHay.some(d => d === t || d.includes(t) || (t.length >= 6 && t.includes(d)))) return;
      // 合并成段：整行或去掉前导破折号后仍在目标正文中
      if (destFlat.includes(t)) return;
      const stripped = t.replace(/^[-]+/, '').trim();
      if (stripped.length >= 4 && destFlat.includes(stripped)) return;
      // 再宽松：去掉空白后连续匹配（防中间多空格/零宽）
      const compact = stripped.replace(/\s+/g, '');
      if (compact.length >= 4 && destFlat.replace(/\s+/g, '').includes(compact)) return;
      missingLines.push({ index: i + 1, text: raw.slice(0, 120), chars: raw.length });
    });
    const srcChars = softNorm(src).replace(/\s+/g, '');
    const destChars = softNorm(dest).replace(/\s+/g, '');
    let firstMismatch = -1;
    const n = Math.min(srcChars.length, destChars.length);
    for (let i = 0; i < n; i++) {
      if (srcChars[i] !== destChars[i]) { firstMismatch = i; break; }
    }
    if (firstMismatch < 0 && srcChars.length !== destChars.length) firstMismatch = n;
    const srcN = srcChars.length;
    const destN = destChars.length;
    const ratio = srcN > 0 ? destN / srcN : 1;
    const srcLineN = srcLines.filter(l => l.trim()).length;
    const hitLineN = srcLineN - missingLines.length;
    const lineRatio = srcLineN > 0 ? hitLineN / srcLineN : 1;
    // 字数够（含目标更多字）且源行都能在目标中找到 → 通过；真缺行才失败
    const charsOk = srcN <= destN + CHAR_ABS_SLACK || ratio >= CHAR_RATIO_ABORT;
    return {
      srcChars: srcN,
      destChars: destN,
      ratio,
      lineRatio,
      srcLines: srcLineN,
      missingLines: missingLines.slice(0, 40),
      firstMismatch,
      ok: charsOk && missingLines.length === 0
    };
  }

  function findRootId(map, hinted) {
    if (hinted && map[hinted]) return hinted;
    const ids = Object.keys(map);
    for (const id of ids) {
      const b = blockBody(map[id]);
      if (b && b.type === 'page') return id;
    }
    for (const id of ids) {
      const b = blockBody(map[id]);
      if (b && !b.parent_id && !b.parentId) return id;
    }
    return ids[0] || '';
  }

  function pickFileToken(body) {
    if (!body) return null;
    const bags = [body.image, body.file, body.view, body.diagram, body.whiteboard, body];
    for (const b of bags) {
      if (!b || typeof b !== 'object') continue;
      const token = b.token || b.file_token || b.fileToken || '';
      if (token && String(token).length >= 16) {
        return { token: String(token), name: b.name || b.filename || b.title || '' };
      }
    }
    return null;
  }

  function headingLevelOf(body) {
    const t = String((body && body.type) || '');
    const m = t.match(/^heading(\d)$/i);
    if (m) return Math.min(6, Math.max(1, Number(m[1])));
    const lv = body && (body.level || body.heading_level || (body.heading && body.heading.level));
    const n = Number(lv);
    if (n >= 1 && n <= 9) return Math.min(6, n);
    if (t === 'heading') return 1;
    return 0;
  }

  function tableShape(body) {
    const cols = (body.columns_id && body.columns_id.length)
      || Number(body.column_size || body.col_size || (body.property && (body.property.column_size || body.property.col_size)) || 0)
      || 0;
    const rows = (body.rows_id && body.rows_id.length)
      || Number(body.row_size || (body.property && body.property.row_size) || 0)
      || 0;
    return { cols: cols || 0, rows: rows || 0 };
  }

  function cellSpan(body) {
    const m = (body && (body.merge_info || body.mergeInfo)) || {};
    const col = Number(m.col_span != null ? m.col_span : (m.colSpan != null ? m.colSpan : (body && body.col_span != null ? body.col_span : 1)));
    const row = Number(m.row_span != null ? m.row_span : (m.rowSpan != null ? m.rowSpan : (body && body.row_span != null ? body.row_span : 1)));
    return { col, row };
  }

  /* 飞书文档引用：可见标题在 inline-component JSON 里，字面文本往往只是一个空格 */
  function expandInlineMention(attrs) {
    if (!attrs || typeof attrs !== 'object') return null;
    const raw = attrs['inline-component'] || attrs.inlineComponent || attrs.mention
      || attrs['mention-doc'] || attrs.mentionDoc || '';
    if (!raw) return null;
    try {
      const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!j || typeof j !== 'object') return null;
      const typ = String(j.type || j.mention_type || '').toLowerCase();
      const okType = !typ || /mention|docx|wiki|doc|file|page/.test(typ);
      if (!okType) return null;
      const d = j.data || j.token_info || {};
      const title = String(d.title || j.title || d.name || j.name || '').trim();
      let url = String(d.raw_url || d.url || j.url || d.link || '').trim();
      const tok = d.token || d.obj_token || d.file_token || j.token || '';
      if (!url && tok) {
        const isFile = /file|pdf|attach/i.test(typ) || /\.pdf$/i.test(title);
        url = isFile ? ('/file/' + tok) : ('/docx/' + tok);
      }
      url = absolutizeHref(url);
      if (!title && !url) return null;
      return { title: title || url, url };
    } catch (e) {
      return null;
    }
  }

  function segmentDisplayText(seg) {
    const mention = expandInlineMention((seg && seg.attrs) || {});
    if (mention && mention.title) return mention.title;
    return (seg && seg.text) || '';
  }

  function renderInlineLines(lines, ctx) {
    return lines.map(line => line.map(seg => {
      const a = seg.attrs || {};
      const mention = expandInlineMention(a);
      let t = mention && mention.title ? mention.title : (seg.text || '');
      if (!String(t).replace(/\s+/g, '')) {
        if (!mention) return '';
        t = mention.title || mention.url || '';
      }
      if (!t) return '';
      let h = esc(t);
      if (attrTruthy(a.inlineCode) || attrTruthy(a['inline-code']) || attrTruthy(a.code)) h = '<code>' + h + '</code>';
      if (attrTruthy(a.bold)) h = '<strong>' + h + '</strong>';
      if (attrTruthy(a.italic)) h = '<em>' + h + '</em>';
      if (attrTruthy(a.underline)) h = '<u>' + h + '</u>';
      if (attrTruthy(a.strikethrough) || attrTruthy(a.strike)) h = '<s>' + h + '</s>';
      let href = absolutizeHref((mention && mention.url) || linkHref(a.link || a.href || a.url));
      if (href && !/["'<>\s]/.test(href)) h = '<a href="' + esc(href) + '">' + h + '</a>';
      // textHighlight:"red"/"pink" 是字色，不是底色（课标题红字）
      const resolved = HN ? HN.resolveInlineColors(a) : {
        color: a.textColor || a.fontColor || a['font-color'] || a.color || '',
        bg: a.backgroundColor || a.highlight || a.backColor || a.textHighlight || a.highlightColor || ''
      };
      const color = resolved.color || '';
      const bg = resolved.bg || '';
      const styles = [];
      let hex = '';
      if (color && !isNearBlack(color) && !isNearWhite(color)) {
        hex = /^#/.test(String(color)) ? String(color).toLowerCase() : rgbToCss(color);
        if (!hex || hex === color) {
          const mapped = HN ? HN.mapFeishuColorToken(color) : '';
          hex = mapped || rgbToCss(color) || String(color);
        }
        styles.push('color:' + hex);
      }
      if (bg && !isTransparentBg(bg) && !isNearWhite(bg)) {
        const bgHex = /^#/.test(String(bg)) ? String(bg).toLowerCase()
          : ((HN && HN.mapFeishuColorToken(bg)) || rgbToCss(bg) || bg);
        styles.push('background-color:' + bgHex);
      }
      if (styles.length) {
        h = '<span style="' + styles.join(';') + '"' + (hex ? ' color="' + esc(hex) + '"' : '') + '>' + h + '</span>';
        if (hex) h = '<font color="' + esc(hex) + '">' + h + '</font>';
      }
      const sample = normLine(t).slice(0, 40);
      const bgHex = (bg && !isTransparentBg(bg) && !isNearWhite(bg)) ? rgbToCss(bg) : '';
      if (sample.length >= 2 && (hex || bgHex || attrTruthy(a.bold) || attrTruthy(a.italic)
        || attrTruthy(a.underline) || attrTruthy(a.strikethrough) || attrTruthy(a.strike)
        || attrTruthy(a.inlineCode) || attrTruthy(a['inline-code']) || attrTruthy(a.code)
        || href)) {
        ctx.styles.push({
          text: sample,
          color: hex ? colorKey(hex) : '',
          colorRaw: hex || '',
          bg: bgHex ? colorKey(bgHex) : '',
          bgRaw: bgHex || '',
          bold: attrTruthy(a.bold),
          italic: attrTruthy(a.italic),
          underline: attrTruthy(a.underline),
          strike: attrTruthy(a.strikethrough) || attrTruthy(a.strike),
          code: attrTruthy(a.inlineCode) || attrTruthy(a['inline-code']) || attrTruthy(a.code),
          link: !!href
        });
      }
      return h;
    }).join('')).join('<br>');
  }

  function pushSnapshotLines(textField, ctx, type) {
    const lines = linesFromTextField(textField);
    lines.forEach((line, i) => {
      const text = normLine(line.map(segmentDisplayText).join(''));
      if (!text) return;
      ctx.lines.push({ id: ctx.seq + '#' + (type || 't') + i, type: type || 'text', text });
      ctx.seq++;
    });
    return lines;
  }

  function alignAttr(body) {
    const a = String((body && (body.align || body.text_align)) || '');
    if (a === 'center' || a === 'right') return ' style="text-align:' + a + '"';
    return '';
  }

  function renderBlockMap(blockMap, rootHint) {
    const ctx = {
      map: blockMap,
      seen: new Set(),
      lines: [],
      styles: [],
      tables: 0,
      images: 0,
      codes: 0,
      seq: 1,
      mediaSeq: 1,
      mediaMap: new Map(),
      codeItems: [],
      headingSamples: []
    };
    const root = findRootId(blockMap, rootHint);
    const html = renderBlock(root, ctx);
    const plain = ctx.lines.map(l => l.text).join('\n');
    const styles = [];
    const seenSt = new Set();
    ctx.styles.forEach(st => {
      const k = [st.text, st.color, st.bg, st.bold ? 1 : 0, st.italic ? 1 : 0,
        st.underline ? 1 : 0, st.strike ? 1 : 0, st.code ? 1 : 0, st.link ? 1 : 0, st.block || ''].join('|');
      if (seenSt.has(k)) return;
      seenSt.add(k);
      styles.push(st);
    });
    // 标题级别也进样式指纹，改正时可 promote
    (ctx.headingSamples || []).forEach(h => {
      const k = h.text + '|block:' + h.block;
      if (seenSt.has(k)) return;
      seenSt.add(k);
      styles.push(h);
    });
    const styleAtoms = SF ? SF.atomsFromStyleSamples(styles) : [];
    const htmlFp = SF ? SF.extractAtomsFromHtml(html) : { atoms: [], structure: {} };
    return {
      html,
      plain,
      images: ctx.images,
      mediaMap: ctx.mediaMap,
      styleAtoms,
      styleStructure: htmlFp.structure,
      inventory: {
        codes: ctx.codeItems,
        headings: [],
        texts: [],
        tables: ctx.tables,
        images: ctx.images,
        plain
      },
      snapshot: {
        lines: ctx.lines,
        styles: styles.slice(0, 400),
        plain,
        counts: {
          lines: ctx.lines.length,
          chars: plain.replace(/\s/g, '').length,
          tables: ctx.tables,
          images: ctx.images,
          codes: ctx.codes,
          styles: Math.min(400, styles.length)
        }
      }
    };
  }

  function renderChildren(ids, ctx) {
    let html = '';
    const list = ids || [];
    let i = 0;
    while (i < list.length) {
      const body = blockBody(ctx.map[list[i]]);
      const type = body && body.type;
      if (type === 'bullet' || type === 'ordered') {
        const tag = type === 'ordered' ? 'ol' : 'ul';
        let inner = '';
        while (i < list.length) {
          const b2 = blockBody(ctx.map[list[i]]);
          if (!b2 || b2.type !== type) break;
          inner += renderListItem(list[i], ctx);
          i++;
        }
        html += '<' + tag + '>' + inner + '</' + tag + '>';
        continue;
      }
      html += renderBlock(list[i], ctx);
      i++;
    }
    return html;
  }

  function renderListItem(id, ctx) {
    if (!id || ctx.seen.has(id)) return '';
    ctx.seen.add(id);
    const body = blockBody(ctx.map[id]);
    if (!body || body.hidden) return '';
    const lines = pushSnapshotLines(body.text, ctx, 'text');
    const inner = renderInlineLines(lines, ctx);
    const kids = renderChildren(childIds(body), ctx);
    return '<li>' + (inner || '') + kids + '</li>';
  }

  /* 飞书表格：单元格在 cell_set（可直挂 body 或嵌套 body.table），值指向 table_cell 块 */
  function renderTableFromCellSet(body, ctx) {
    const layout = BT ? BT.tableLayout(body) : null;
    const rows = (layout && layout.rows) || [];
    const cols = (layout && layout.cols) || [];
    const cellSet = layout && layout.cellSet;
    if (!cellSet || !rows.length || !cols.length) return '';
    ctx.tables++;
    const colSet = (layout && layout.columnSet) || {};
    let html = '<table>';
    const widthCols = cols.filter(col => colSet[col] && Number(colSet[col].column_width) > 20);
    if (widthCols.length) {
      html += '<colgroup>';
      cols.forEach(col => {
        const w = colSet[col] && Number(colSet[col].column_width);
        html += (w > 20 && w < 4000) ? '<col style="width:' + Math.round(w) + 'px">' : '<col>';
      });
      html += '</colgroup>';
    }
    rows.forEach(row => {
      html += '<tr>';
      cols.forEach(col => {
        const raw = cellSet[row + col] || cellSet[row + '_' + col] || null;
        if (!raw) {
          html += '<td></td>';
          return;
        }
        const blockId = typeof raw === 'string' ? raw : (raw.block_id || raw.blockId || '');
        const merge = (raw && typeof raw === 'object' && raw.merge_info) || {};
        const colSpan = merge.col_span != null ? Number(merge.col_span) : 1;
        const rowSpan = merge.row_span != null ? Number(merge.row_span) : 1;
        if (colSpan === 0 || rowSpan === 0) return;
        if (blockId) ctx.seen.add(blockId);
        const cell = blockBody(ctx.map[blockId]);
        const inner = cell ? renderChildren(childIds(cell), ctx) : '';
        html += '<td'
          + (colSpan > 1 ? ' colspan="' + colSpan + '"' : '')
          + (rowSpan > 1 ? ' rowspan="' + rowSpan + '"' : '')
          + '>' + inner + '</td>';
      });
      html += '</tr>';
    });
    html += '</table>';
    return html;
  }

  function renderBlock(id, ctx) {
    if (!id || ctx.seen.has(id)) return '';
    ctx.seen.add(id);
    const body = blockBody(ctx.map[id]);
    if (!body || body.hidden) return '';
    const type = String(body.type || 'text');
    const kids = () => renderChildren(childIds(body), ctx);

    if (type === 'page') {
      const lines = pushSnapshotLines(body.text, ctx, 'heading');
      const title = renderInlineLines(lines, ctx);
      return (title ? '<h1>' + title + '</h1>' : '') + kids();
    }

    const level = headingLevelOf(body);
    if (level) {
      const lines = pushSnapshotLines(body.text, ctx, 'heading');
      const inner = renderInlineLines(lines, ctx);
      const ht = normLine(lines.map(line => line.map(segmentDisplayText).join('')).join(' ')).slice(0, 80);
      if (ht.length >= 2) {
        ctx.headingSamples.push({ text: ht, block: 'h' + level, bold: false });
      }
      return '<h' + level + alignAttr(body) + '>' + inner + '</h' + level + '>' + kids();
    }

    if (type === 'code') {
      const plain = plainFromCodeBody(body);
      ctx.codes++;
      plain.split('\n').forEach((ln, i) => {
        const t = normLine(ln);
        if (t) ctx.lines.push({ id: 'code' + ctx.seq + '#' + i, type: 'code', text: t });
      });
      ctx.seq++;
      if (plain.trim()) {
        ctx.codeItems.push({
          kind: '代码块',
          lines: plain.split('\n').length,
          preview: plain.split('\n').slice(0, 2).join(' / ').slice(0, 80),
          needle: plain.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 8),
          full: plain
        });
      }
      return renderCodeHtmlFromBody(body);
    }

    if (type === 'image' || type === 'diagram' || type === 'whiteboard' || type === 'mindnote') {
      const file = pickFileToken(body);
      const cap = renderInlineLines(pushSnapshotLines(body.text, ctx, 'text'), ctx);
      if (file) {
        ctx.images++;
        const w = Number((body.image && body.image.width) || body.width || 0);
        const widthAttr = w > 40 && w < 4000 ? ' width="' + Math.round(w) + '"' : '';
        const token = String(file.token || '').replace(/[^A-Za-z0-9]/g, '');
        if (!token) return cap ? '<p>' + cap + '</p>' : '';
        return '<p><img src="/space/api/box/stream/download/all/' + token + '" alt="' + esc(file.name || '') + '"' + widthAttr + '></p>'
          + (cap ? '<p>' + cap + '</p>' : '');
      }
      return cap ? '<p>' + cap + '</p>' : '';
    }

    if (type === 'table') {
      const fromCells = renderTableFromCellSet(body, ctx);
      if (fromCells) return fromCells;
      ctx.tables++;
      const cells = childIds(body);
      let shape = tableShape(body);
      let cols = shape.cols;
      let rows = shape.rows;
      if (!cols && rows && cells.length && cells.length % rows === 0) cols = cells.length / rows;
      if (!rows && cols && cells.length && cells.length % cols === 0) rows = cells.length / cols;
      if (!cols) cols = Math.max(1, cells.length);
      if (!rows) rows = Math.max(1, Math.ceil(cells.length / cols));
      let html = '<table>';
      let idx = 0;
      for (let r = 0; r < rows && idx < cells.length; r++) {
        html += '<tr>';
        let c = 0;
        while (c < cols && idx < cells.length) {
          const cid = cells[idx++];
          ctx.seen.add(cid);
          const cb = blockBody(ctx.map[cid]) || {};
          const sp = cellSpan(cb);
          if (sp.col === 0 || sp.row === 0) continue;
          const inner = renderChildren(childIds(cb), ctx) || renderInlineLines(pushSnapshotLines(cb.text, ctx, 'text'), ctx);
          html += '<td'
            + (sp.col > 1 ? ' colspan="' + sp.col + '"' : '')
            + (sp.row > 1 ? ' rowspan="' + sp.row + '"' : '')
            + '>' + (inner || '') + '</td>';
          c += Math.max(1, sp.col);
        }
        html += '</tr>';
      }
      html += '</table>';
      return html;
    }

    if (type === 'grid') {
      ctx.tables++;
      const cols = childIds(body);
      let html = '<table><tr>';
      cols.forEach(cid => {
        ctx.seen.add(cid);
        const col = blockBody(ctx.map[cid]) || {};
        html += '<td>' + renderChildren(childIds(col), ctx) + '</td>';
      });
      html += '</tr></table>';
      return html;
    }

    if (type === 'divider' || type === 'horizontal-line') return '<hr>';

    if (type === 'quote' || type === 'quote_container') {
      const lines = pushSnapshotLines(body.text, ctx, 'text');
      const inner = renderInlineLines(lines, ctx);
      return '<blockquote>' + (inner ? '<p>' + inner + '</p>' : '') + kids() + '</blockquote>';
    }

    if (type === 'callout') {
      const bgRaw = String(body.background_color || body.backgroundColor || '');
      const bgOk = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(bgRaw) || /^rgba?\([0-9.,\s%]+\)$/i.test(bgRaw);
      const style = 'border-left:3px solid #bbbfc4;padding:8px 12px;background:' + (bgOk ? bgRaw : '#f5f6f7');
      const lines = pushSnapshotLines(body.text, ctx, 'text');
      const inner = renderInlineLines(lines, ctx);
      const emoji = (body.emoji && typeof body.emoji === 'string') ? body.emoji : '';
      return '<blockquote style="' + esc(style) + '">'
        + (emoji || inner ? '<p>' + esc(emoji) + (emoji && inner ? ' ' : '') + inner + '</p>' : '')
        + kids()
        + '</blockquote>';
    }

    if (type === 'todo' || type === 'task') {
      const done = !!(body.done || body.checked || (body.todo && body.todo.done));
      const lines = pushSnapshotLines(body.text, ctx, 'text');
      const inner = renderInlineLines(lines, ctx);
      return '<p>' + (done ? '☑ ' : '☐ ') + inner + '</p>' + kids();
    }

    if (type === 'file' || type === 'view') {
      const file = pickFileToken(body);
      const name = (file && file.name) || body.name || '附件';
      const lines = pushSnapshotLines(body.text, ctx, 'text');
      const cap = renderInlineLines(lines, ctx);
      if (file) {
        const id = String(ctx.mediaSeq++);
        ctx.mediaMap.set(id, {
          token: file.token,
          name,
          fileName: String(name).replace(/[\\/:*?"<>|]/g, '_')
        });
        return '<div data-fxfer-media="' + id + '"></div>' + (cap ? '<p>' + cap + '</p>' : '');
      }
      return '<p>【附件】' + esc(name) + '</p>' + (cap ? '<p>' + cap + '</p>' : '');
    }

    if (type === 'equation') {
      const latex = plainFromTextField(body.text) || body.latex || (body.equation && (body.equation.latex || body.equation.content)) || '';
      const t = normLine(latex);
      if (t) ctx.lines.push({ id: 'eq' + ctx.seq++, type: 'text', text: t });
      return '<p><code>' + esc(latex || '【公式】') + '</code></p>';
    }

    if (type === 'sheet' || type === 'bitable' || type === 'synced_source' || type === 'iframe' || type === 'isv') {
      const lines = pushSnapshotLines(body.text, ctx, 'text');
      const inner = renderInlineLines(lines, ctx);
      const label = type === 'iframe' || type === 'isv' ? '嵌入内容' : '嵌套表';
      return '<p>【' + label + '】' + (inner ? ' ' + inner : '') + '</p>' + kids();
    }

    const lines = pushSnapshotLines(body.text, ctx, 'text');
    const inner = renderInlineLines(lines, ctx);
    const rest = kids();
    // 空段落也要保留：飞书用空 text 块表示段间距；丢掉会「没换行/不成段」
    if (!inner && !rest) {
      if (type === 'text' || type === 'paragraph' || type === '') return '<p><br></p>';
      return '';
    }
    return (inner ? '<p' + alignAttr(body) + '>' + inner + '</p>' : '') + rest;
  }

  async function loadDocModel(onProgress) {
    if (!BT) return null;
    const source = await resolveSourceObj();
    if (!source || !source.token) return null;
    const token = source.token;
    const wiki = source.wiki || '';
    let spaceId = '';
    if (wiki) {
      try {
        const info = await fetchWikiNode(wiki);
        if (info && info.spaceId) spaceId = info.spaceId;
      } catch (e) { }
    }
    const wikiPart = wiki
      ? ('&wiki_space_id=' + encodeURIComponent(spaceId || '')
        + '&container_type=wiki2.0&container_id=' + encodeURIComponent(wiki))
      : '';

    const blockMap = {};
    const skipped = new Set();
    let rootId = '';
    let sequence = [];
    const seqSeen = new Set();
    let pagingHitLimit = false;
    let pagingStoppedEarly = false;
    let skipTruncated = false;

    const absorb = (part) => {
      if (!part || !part.blockMap) return 0;
      if (!rootId) rootId = part.id || '';
      return BT.absorbPart(blockMap, skipped, sequence, seqSeen, part);
    };

    // ① 无 limit 的一次拉取：长文常能直接拿全（本课实测 623 块 / has_more=false）
    onProgress && onProgress('读取文档数据（全量）…', 8);
    let part = unpackClientVars(await feishuGetJson(
      '/space/api/docx/pages/client_vars?id=' + encodeURIComponent(token) + wikiPart
    ));
    absorb(part);

    // ② 若仍有续页，按 LarkSnap 方式穷举 cursor 组合，合并 children 并集
    if (part && part.hasMore) {
      let cursor = part.cursor || '';
      let nextCursors = part.nextCursors;
      let hasMore = true;
      let winner = '';
      let guard = 0;
      const rootBlockId = Object.keys(blockMap).find(id => (blockBody(blockMap[id]) || {}).type === 'page')
        || token;
      for (; hasMore && guard < CLIENT_VARS_PAGE_LIMIT; guard++) {
        if (window.__fxferAbort) throw new Error('已中止');
        onProgress && onProgress('续读文档数据 ' + (guard + 2) + '…', 10 + Math.min(30, guard));
        const next = firstCursorOf(nextCursors);
        const variants = [];
        const push = (tag, base, c) => {
          if (!c) return;
          const parts = [];
          if (base) parts.push(base);
          parts.push('cursor=' + encodeURIComponent(c));
          parts.push('limit=239');
          variants.push({ tag, q: parts.join('&') });
        };
        push('m1', 'mode=1', cursor);
        push('m1n', 'mode=1', next);
        push('bare', '', cursor);
        push('baren', '', next);
        push('prid', 'mode=4&paging_root_id=' + encodeURIComponent(rootBlockId), cursor);
        push('bid', 'mode=4&block_id=' + encodeURIComponent(rootBlockId), cursor);
        const ordered = winner
          ? variants.filter(v => v.tag === winner).concat(variants.filter(v => v.tag !== winner))
          : variants;
        let got = null;
        for (const v of ordered) {
          const q = '/space/api/docx/pages/client_vars?id=' + encodeURIComponent(token)
            + '&' + v.q + wikiPart;
          const cand = unpackClientVars(await feishuGetJson(q));
          if (!cand || !cand.blockMap) continue;
          const fresh = Object.keys(cand.blockMap).filter(id => !blockMap[id]).length;
          if (fresh > 0) { got = cand; winner = v.tag; break; }
        }
        if (!got) {
          pagingStoppedEarly = true;
          break;
        }
        absorb(got);
        hasMore = !!got.hasMore;
        cursor = got.cursor || '';
        nextCursors = got.nextCursors;
        if (!cursor && !firstCursorOf(nextCursors)) {
          if (hasMore) pagingStoppedEarly = true;
          break;
        }
      }
      if (hasMore && guard >= CLIENT_VARS_PAGE_LIMIT) pagingHitLimit = true;
    }

    // ③ 迭代补拉 skip_blocks 子树（表格单元格等；新页可能再带出 skip）
    let skipRequests = 0;
    for (let round = 0; round < SKIP_FETCH_MAX_ROUNDS; round++) {
      const pending = BT.missingSkipIds(skipped, blockMap);
      if (!pending.length) break;
      if (skipRequests >= SKIP_FETCH_MAX_REQUESTS) {
        skipTruncated = true;
        break;
      }
      for (let i = 0; i < pending.length; i += SKIP_FETCH_CONCURRENCY) {
        if (window.__fxferAbort) throw new Error('已中止');
        if (skipRequests >= SKIP_FETCH_MAX_REQUESTS) {
          skipTruncated = true;
          break;
        }
        const batch = pending.slice(i, i + SKIP_FETCH_CONCURRENCY);
        onProgress && onProgress(
          '补拉嵌套块 ' + Math.min(skipRequests + batch.length, pending.length + skipRequests)
          + '（轮次 ' + (round + 1) + '）…',
          40 + Math.min(20, round)
        );
        const parts = await Promise.all(batch.map(async (id) => {
          const q = '/space/api/docx/pages/client_vars?id=' + encodeURIComponent(token)
            + '&mode=4&block_id=' + encodeURIComponent(id) + '&limit=239' + wikiPart;
          return unpackClientVars(await feishuGetJson(q));
        }));
        skipRequests += batch.length;
        parts.forEach(p => absorb(p));
      }
      if (skipTruncated) break;
    }
    if (BT.missingSkipIds(skipped, blockMap).length) skipTruncated = true;

    if (!Object.keys(blockMap).length) {
      const bodies = [
        { type: 'CLIENT_VARS', data: { type: 'CLIENT_VARS', token }, version: 2, req_id: 1 },
        { type: 'DOC_VAR', data: { type: 'CLIENT_VARS', token }, version: 1, req_id: 0 }
      ];
      for (const body of bodies) {
        const p = unpackClientVars(await feishuPostJson('/space/api/docx/pages/client_vars', body));
        if (p) { absorb(p); break; }
      }
    }

    const n = Object.keys(blockMap).length;
    if (!n) return null;

    const pageRoot = Object.keys(blockMap).find(id => (blockBody(blockMap[id]) || {}).type === 'page')
      || rootId
      || sequence[0]
      || '';
    if (pageRoot) BT.patchRootChildren(blockMap, pageRoot, sequence);

    const missingCells = BT.missingTableCellIds(blockMap);
    const issues = BT.completenessIssues({
      pagingHitLimit,
      pagingStoppedEarly: pagingStoppedEarly && !pagingHitLimit,
      skipRemaining: BT.missingSkipIds(skipped, blockMap).length,
      missingTableCells: missingCells.length
    });

    const rendered = renderBlockMap(blockMap, pageRoot);
    const headingBlocks = Object.keys(blockMap).filter(id => /^heading[1-9]$/i.test(String((blockBody(blockMap[id]) || {}).type || ''))).length;
    const headingTags = (rendered.html.match(/<h[1-6]\b/gi) || []).length;
    if (headingBlocks > 0 && headingTags === 0) return null;
    const chars = countPlainChars(rendered.plain);
    if (chars < 1 && !(rendered.images > 0)) return null;
    return {
      html: transferBannerHtml() + rendered.html,
      mediaMap: rendered.mediaMap,
      plain: rendered.plain,
      images: rendered.images,
      blocks: n,
      inventory: rendered.inventory,
      snapshot: rendered.snapshot,
      styleAtoms: rendered.styleAtoms || [],
      styleStructure: rendered.styleStructure || null,
      issues,
      skipRequests,
      missingTableCells: missingCells.length
    };
  }

  /* ---------------- 主流程 ---------------- */

  /* 谁内容更全用谁：逻辑在 core/block-tree，防课表半残覆盖、长文选模型 */
  function shouldPreferModel(model, domInventory, domHtml) {
    return BT ? BT.shouldPreferModel(model, domInventory, domHtml) : false;
  }

  function pickCopiedDocUrl(j) {
    if (!j || (j.code !== 0 && j.code !== '0')) return '';
    const d = j.data || {};
    if (typeof d.url === 'string' && d.url) return d.url;
    if (d.node && typeof d.node.url === 'string' && d.node.url) return d.node.url;
    const obj = d.obj_token || d.token || (d.node && (d.node.obj_token || d.node.token)) || '';
    const wiki = d.wiki_token || (d.node && d.node.wiki_token) || '';
    if (wiki) return location.origin + '/wiki/' + wiki;
    if (obj) return location.origin + '/docx/' + obj;
    return '';
  }

  /** 仅收集「用户侧可写」知识库目标；禁止把源 wiki 当写入目标（会 NodePermFail） */
  async function collectWritableWikiTargets(source) {
    const out = [];
    const push = (spaceId, wikiToken, tag) => {
      const sid = spaceId != null ? String(spaceId) : '';
      const wt = wikiToken != null ? String(wikiToken) : '';
      if (!sid && !wt) return;
      out.push({ spaceId: sid, wikiToken: wt, tag: tag || '' });
    };
    let sourceSpaceId = '';
    if (source && source.wiki) {
      try {
        const info = await fetchWikiNode(source.wiki);
        if (info && info.spaceId) sourceSpaceId = String(info.spaceId);
      } catch (e) { }
    }
    // 尽量自动枚举可写知识库
    const listUrls = [
      '/space/api/wiki/v2/space/get_list/',
      '/space/api/wiki/v2/space/list/',
      '/space/api/wiki/v2/space/get_visited_list/',
      '/space/api/wiki/v2/space/get_my_list/',
      '/space/api/wiki/v2/space/get_user_spaces/'
    ];
    for (const u of listUrls) {
      try {
        const j = await feishuGetJson(u);
        if (!j || (j.code !== 0 && j.code !== '0')) continue;
        const d = j.data || {};
        const spaces = d.spaces || d.items || d.list || d.space_list || [];
        if (!Array.isArray(spaces)) continue;
        spaces.slice(0, 12).forEach((sp, i) => {
          const sid = sp && (sp.space_id || sp.spaceId || sp.id);
          if (!sid) return;
          if (sourceSpaceId && String(sid) === sourceSpaceId) return;
          const root = sp && (sp.wiki_token || sp.root_token || sp.space_token || sp.root_wiki_token || '');
          push(sid, root || '', 'mine-' + i);
        });
      } catch (e) { }
    }
    // 允许用户曾保存的目标 wiki URL
    try {
      const saved = await storageGet('fxfer_wiki_target');
      if (saved && saved.spaceId && !(sourceSpaceId && String(saved.spaceId) === sourceSpaceId)) {
        push(saved.spaceId, saved.wikiToken || '', 'saved-wiki');
      }
    } catch (e) { }
    const seen = new Set();
    return out.filter(t => {
      const k = t.spaceId + '|' + t.wikiToken;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  function pickTokenFromObj(o) {
    if (!o || typeof o !== 'object') return '';
    return String(
      o.token || o.root_token || o.folder_token || o.node_token
      || o.parent_token || o.obj_token || o.id || ''
    );
  }

  /** Cookie 态解析「我的空间」根目录 folder_token（不要用 wiki space_id） */
  async function getMySpaceRootToken(onDetail) {
    const cached = await storageGet(STORAGE_ROOT_TOKEN_KEY);
    if (cached && cached.token && cached.origin === location.origin) {
      return String(cached.token);
    }
    // 官方 root_folder/meta；OpenAEON 等开源项目证实根可用 token「0」
    const getUrls = [
      '/space/api/explorer/v2/root_folder/meta',
      '/space/api/explorer/v2/root_folder/meta/',
      '/space/api/explorer/v2/root/get/',
      '/space/api/explorer/v2/rootfolder/get/',
      '/space/api/explorer/v2/root/meta/',
      '/space/api/explorer/v3/my_space/',
      '/space/api/explorer/v3/my_space/root/'
    ];
    for (const u of getUrls) {
      if (window.__fxferAbort) throw new Error('已中止');
      try {
        const j = await feishuGetJson(u);
        if (!j || (j.code !== 0 && j.code !== '0')) continue;
        const d = j.data || {};
        const t = pickTokenFromObj(d)
          || pickTokenFromObj(d.root)
          || pickTokenFromObj(d.folder)
          || pickTokenFromObj(d.node)
          || pickTokenFromObj(d.space);
        if (t && String(t).length >= 1) {
          storageSet(STORAGE_ROOT_TOKEN_KEY, { token: String(t), origin: location.origin, via: u });
          onDetail && onDetail('已解析我的空间根目录（' + u.split('/').slice(-2).join('/') + '）');
          return String(t);
        }
      } catch (e) { }
    }
    // 从 my_space/folder 列表响应里抠 parent / root
    try {
      const data = await driveFetchJson('my_space/folder/?length=5');
      const t = pickTokenFromObj(data)
        || String(data.parent_token || data.root_token || data.token || '');
      if (t && t.length >= 1) {
        storageSet(STORAGE_ROOT_TOKEN_KEY, { token: t, origin: location.origin, via: 'my_space/folder' });
        return t;
      }
      const nodes = (data.entities && data.entities.nodes) || {};
      for (const key of Object.keys(nodes)) {
        const n = nodes[key];
        const p = n && (n.parent_token || n.parent_node_token || n.parent);
        if (p && String(p).length >= 1) {
          storageSet(STORAGE_ROOT_TOKEN_KEY, { token: String(p), origin: location.origin, via: 'child-parent' });
          onDetail && onDetail('由子文件夹 parent 推断根目录 token');
          return String(p);
        }
      }
    } catch (e) { }
    return '';
  }

  /**
   * 解析最终 Drive 目标 token。
   * 用户选了子文件夹 → 用它；否则取根；再不行用开源项目证实的「0」代表我的空间根。
   */
  async function ensureDriveDestToken(preferred, onDetail) {
    if (preferred) return String(preferred);
    const root = await getMySpaceRootToken(onDetail);
    if (root) return root;
    onDetail && onDetail('根 token 未解析到，回退 folder_token=0（我的空间根，对齐开源用法）');
    return '0';
  }

  /** 在我的空间下确保有一个可写文件夹（拿真实 token，避免部分 copy 接口拒收 0） */
  async function ensureWritableDriveFolder(preferred, onDetail) {
    const base = await ensureDriveDestToken(preferred, onDetail);
    if (preferred) return base;
    // 若已是真实 token（非 0），直接用
    if (base && base !== '0') return base;
    const name = '飞书转存';
    const createAttempts = [
      {
        url: '/space/api/explorer/v2/create/folder/',
        body: { name, parent_token: base }
      },
      {
        url: '/space/api/explorer/v3/create/folder/',
        body: { name, parent_token: base }
      },
      {
        url: '/space/api/explorer/v2/create/object/',
        body: { type: OBJ_TYPE_FOLDER, name, parent_token: base }
      },
      {
        url: '/space/api/explorer/create/',
        body: { type: 0, name, parent_token: base === '0' ? '' : base }
      }
    ];
    for (const a of createAttempts) {
      try {
        const j = await feishuPostJson(a.url, a.body);
        if (!j || (j.code !== 0 && j.code !== '0')) continue;
        const d = j.data || {};
        const tok = pickTokenFromObj(d)
          || pickTokenFromObj(d.node)
          || pickTokenFromObj(d.folder)
          || (d.token || d.obj_token || '');
        if (tok && tok !== '0') {
          onDetail && onDetail('已在我的空间创建文件夹「' + name + '」');
          storageSet(STORAGE_ROOT_TOKEN_KEY, { token: String(tok), origin: location.origin, via: 'created-folder' });
          return String(tok);
        }
      } catch (e) { }
    }
    // 创建失败仍用 base（可能是 0），让 copy 自己试
    return base;
  }

  function pickDriveCopyUrl(j) {
    const u = pickCopiedDocUrl(j);
    if (u) return u;
    if (!j || (j.code !== 0 && j.code !== '0')) return '';
    const d = j.data || {};
    const file = d.file || d.node || d.obj || d;
    const tok = file.token || file.obj_token || d.token || d.obj_token || '';
    const typ = file.type || d.type;
    if (!tok) {
      if (d.node_list && d.entities && d.entities.nodes) {
        const first = d.node_list[0];
        const node = d.entities.nodes[first];
        if (node && (node.url || node.obj_token || node.token)) {
          return node.url || (location.origin + '/docx/' + (node.obj_token || node.token));
        }
      }
      return '';
    }
    if (file.url) return file.url;
    if (typ === 3 || typ === 'sheet') return location.origin + '/sheets/' + tok;
    if (typ === 8 || typ === 'bitable') return location.origin + '/base/' + tok;
    return location.origin + '/docx/' + tok;
  }

  /** clone 响应：data.entities.nodes[*].url */
  function pickCloneDriveUrl(j) {
    if (!j || (j.code !== 0 && j.code !== '0')) return '';
    const d = j.data || {};
    const nodes = (d.entities && d.entities.nodes) || d.nodes || {};
    if (nodes && typeof nodes === 'object') {
      const keys = Object.keys(nodes);
      if (keys.length) {
        const node = nodes[keys[0]];
        if (node && node.url) return String(node.url);
        const tok = node && (node.token || node.obj_token || node.file_token);
        if (tok) {
          const typ = node.type;
          if (typ === 3 || typ === 'sheet') return location.origin + '/sheets/' + tok;
          if (typ === 8 || typ === 'bitable') return location.origin + '/base/' + tok;
          return location.origin + '/docx/' + tok;
        }
      }
    }
    if (d.node_list && d.entities && d.entities.nodes) {
      const first = d.node_list[0];
      const node = d.entities.nodes[first];
      if (node && node.url) return String(node.url);
    }
    return pickDriveCopyUrl(j);
  }

  /**
   * 「飞书云盘」原生复制：
   * POST /space/api/explorer/v2/clone/
   * Content-Type: application/x-www-form-urlencoded
   * scene=space_copy；parent_token 可为空（落我的空间/云盘根）
   */
  async function tryDriveObjectCopy(source, folderToken, title, onProgress, onDetail) {
    if (!source || !source.token) return { error: '无源 obj_token' };
    onProgress && onProgress('云盘原生复制…', 6);

    // 用户选了子文件夹就用；根目录 parent_token 传空串
    let parent = folderToken ? String(folderToken) : '';
    if (parent === '0') parent = '';
    // 若空且能解析到真实根 token，也可试一次（部分租户更认真实 token）
    const parentCandidates = [parent];
    if (!parent) {
      try {
        const root = await getMySpaceRootToken(onDetail);
        if (root && root !== '0' && parentCandidates.indexOf(root) < 0) {
          parentCandidates.push(root);
        }
      } catch (e) { /* ignore */ }
      if (parentCandidates.indexOf('') < 0) parentCandidates.push('');
    }

    const url = '/space/api/explorer/v2/clone/';
    const objType = Number(source.type) || OBJ_TYPE_DOCX;
    const errors = [];
    let attempt = 0;

    for (const p of parentCandidates) {
      if (window.__fxferAbort) throw new Error('已中止');
      attempt++;
      onProgress && onProgress('云盘原生复制 ' + attempt + '…', 6 + Math.min(16, attempt * 3));
      const fields = {
        obj_token: source.token,
        obj_type: String(objType),
        parent_token: p == null ? '' : String(p),
        title: title || '文档副本',
        need_comment: '0',
        time_zone: 'Asia/Shanghai',
        ext_info: JSON.stringify({ only_schema: 'false', only_base_app: 'true' }),
        source: '0',
        ua_type: 'Web',
        scene: 'space_copy',
        copy_source: '7'
      };
      const j = await feishuPostForm(url, fields);
      const okBiz = !!(j && (j.code === 0 || j.code === '0'));
      const docUrl = pickCloneDriveUrl(j);
      if (docUrl) {
        storageSet(STORAGE_COPY_API_KEY, {
          url,
          bodyTag: 'explorer_v2_clone',
          parent_token: fields.parent_token,
          origin: location.origin,
          at: Date.now()
        });
        onDetail && onDetail('云盘原生复制成功（explorer/v2/clone）');
        return {
          url: docUrl,
          method: 'drive_clone',
          api: url,
          bodyTag: 'explorer_v2_clone',
          folderToken: fields.parent_token || 'root',
          placed: true,
          raw: j
        };
      }
      if (okBiz) {
        onDetail && onDetail('clone 返回成功但无法解析新链接，已停止防重复');
        return {
          error: '云盘复制疑似成功，请到「我的空间」查看是否已生成副本',
          raw: j,
          api: url
        };
      }
      const msg = (j && (j.msg || j.message || j.code)) != null
        ? String(j.msg || j.message || j.code)
        : '无响应';
      errors.push((p ? 'folder' : 'root') + ':' + msg);
      if (j && (j.code === 404 || /page not found/i.test(msg))) {
        return { error: 'clone 接口 404：' + msg };
      }
      if (/NodePermFail|无权限|not allow|forbid|禁止复制|403/i.test(msg)) {
        return { error: '源文档可能禁止创建副本：' + msg, softStop: true };
      }
      // Parameter Error 时换 parent 再试；其它错误也试下一个 parent
    }
    return { error: errors.filter(Boolean).slice(0, 4).join('；') || '云盘 clone 未成功' };
  }

  /**
   * Wiki→Wiki：服务端按对象复制。
   * 仅当存在用户自己的可写知识库目标时使用；载荷字段已解码确认。
   */
  async function tryWikiObjectCopy(source, title, onProgress, onDetail) {
    const targets = await collectWritableWikiTargets(source);
    if (!targets.length) {
      return { error: '无可写知识库目标（不会再把源 wiki 当目标）' };
    }
    const errors = [];
    let attempt = 0;
    for (const target of targets) {
      if (window.__fxferAbort) throw new Error('已中止');
      attempt++;
      onProgress && onProgress('Wiki 原生复制 ' + attempt + '/' + targets.length + '…', 28 + attempt);
      const body = {
        obj_token: source.token,
        obj_type: Number(source.type) || OBJ_TYPE_DOCX,
        ua_type: 'Web',
        scene: 'space_copy_to_wiki',
        ext_info: { only_schema: 'false', only_base_app: 'true' }
      };
      if (title) body.title = title;
      if (target.spaceId) body.target_space_id = String(target.spaceId);
      if (target.wikiToken) body.target_wiki_token = String(target.wikiToken);
      if (!body.target_space_id && !body.target_wiki_token) continue;

      const j = await feishuPostJson('/space/api/wiki/v2/tree/node/copy_by_obj/', body);
      const url = pickCopiedDocUrl(j);
      if (url) {
        storageSet('fxfer_wiki_target', {
          spaceId: target.spaceId,
          wikiToken: target.wikiToken,
          tag: target.tag
        });
        onDetail && onDetail('Wiki 原生复制成功（' + target.tag + '）');
        return { url, method: 'copy_by_obj', attempt, target, raw: j };
      }
      const msg = (j && (j.msg || j.message || j.code)) != null
        ? String(j.msg || j.message || j.code)
        : '无响应';
      errors.push(target.tag + ':' + msg);
    }
    return { error: errors.filter(Boolean).slice(0, 6).join('；') || 'copy_by_obj 失败' };
  }

  /**
   * 原生复制入口（方案 B 第一轨）：
   * 默认 → 飞书云盘（explorer/v2/clone）；
   * 仅用户主动粘贴知识库链接时 → copy_by_obj。
   */
  async function tryNativeObjectCopy(onProgress, onDetail, destFolder) {
    const source = await resolveSourceObj();
    if (!source || !source.token) {
      return { error: '无法解析源文档 token' };
    }
    let title = docTitle();
    title = title.replace(/\s*[-–—]\s*飞书文档\s*$/i, '').trim() || title;
    const folderToken = destFolder && destFolder.token ? String(destFolder.token) : '';
    const preferWiki = !!(destFolder && destFolder.mode === 'wiki' && destFolder.spaceId);
    onDetail && onDetail('原生复制：obj=' + source.token
      + '，目标=' + ((destFolder && destFolder.path) || '飞书云盘/我的空间'));

    onProgress && onProgress('检查是否允许创建副本…', 4);
    const perm = await probeDuplicatePermission(source);
    if (perm.ok === false) {
      onDetail && onDetail('预检：源文档 duplicate/copy 权限关闭（' + perm.reason + '）');
    } else if (perm.ok === true) {
      onDetail && onDetail('预检：源文档允许创建副本');
    } else {
      onDetail && onDetail('预检：未能读取权限位（' + perm.reason + '），继续尝试服务端复制');
    }

    const errors = [];

    if (!preferWiki) {
      onProgress && onProgress('自动复制到飞书云盘…', 6);
      const drive = await tryDriveObjectCopy(source, folderToken, title, onProgress, onDetail);
      if (drive && drive.url) return drive;
      if (drive && drive.error) {
        if (drive.softStop || /Forbidden|禁止|forbid|NodePermFail/i.test(drive.error)) {
          return { error: drive.error, softStop: true, perm };
        }
        errors.push('云盘:' + drive.error);
      }
    }

    if (preferWiki) {
      onProgress && onProgress('复制到指定知识库…', 8);
      const body = {
        obj_token: source.token,
        obj_type: Number(source.type) || OBJ_TYPE_DOCX,
        ua_type: 'Web',
        scene: 'space_copy_to_wiki',
        ext_info: { only_schema: 'false', only_base_app: 'true' },
        target_space_id: String(destFolder.spaceId)
      };
      if (title) body.title = title;
      if (destFolder.wikiToken) body.target_wiki_token = String(destFolder.wikiToken);
      const j = await feishuPostJson('/space/api/wiki/v2/tree/node/copy_by_obj/', body);
      const url = pickCopiedDocUrl(j);
      if (url) {
        storageSet('fxfer_wiki_target', {
          spaceId: destFolder.spaceId,
          wikiToken: destFolder.wikiToken || '',
          tag: 'user-url'
        });
        onDetail && onDetail('Wiki 原生复制成功');
        return { url, method: 'copy_by_obj', placed: true, raw: j };
      }
      const wmsg = (j && (j.msg || j.message || j.code)) != null
        ? String(j.msg || j.message || j.code)
        : 'fail';
      errors.push('Wiki:' + wmsg);
      if (/Forbidden|禁止|forbid|NodePermFail/i.test(wmsg)) {
        return { error: wmsg, softStop: true, perm };
      }
      const drive = await tryDriveObjectCopy(source, '', title, onProgress, onDetail);
      if (drive && drive.url) return drive;
      if (drive && drive.error) errors.push('云盘:' + drive.error);
    }

    if (perm.ok === false && !errors.length) {
      return { error: '源文档禁止创建副本（预检）', softStop: true, perm };
    }
    return { error: errors.filter(Boolean).join('；') || '原生复制失败', perm };
  }

  async function transfer({ progress, detail, destFolder }) {
    window.__fxferAbort = false;

    const sc = getScroller();
    if (!sc) { const e = new Error('未找到文档容器'); e.detail = '请刷新页面后重试。'; throw e; }

    // ① 能原生就原生；② 禁止复制则高保真重建（只要结果跟原文一致）
    progress('优先尝试原生对象复制…', 4);
    let nativeFailNote = '';
    try {
      const native = await tryNativeObjectCopy(progress, detail, destFolder);
      if (native && native.url) {
        detail('原生对象复制成功。');
        return {
          docUrl: native.url,
          videos: [],
          fromModel: false,
          nativeCopy: true,
          nativePlaced: !!(native.placed
            || native.method === 'drive_clone'
            || native.method === 'drive_copy'
            || native.method === 'copy_by_obj'),
          preCharsOk: true
        };
      }
      nativeFailNote = (native && native.error) || '原生复制未成功';
    } catch (e) {
      if (e && e.message === '已中止') throw e;
      nativeFailNote = (e && e.message) ? e.message : String(e);
    }

    detail('原生不可用（' + nativeFailNote + '）。切换高保真重建…');
    progress('采集页面正文…', 8);
    let collected = await collectDoc((t, p) => progress(t, p));
    let fromModel = false;
    let modelSnap = null;
    let modelPlainForGate = '';
    let srcStyleAtoms = [];
    let srcStyleStructure = null;
    const domHtmlBackup = collected.html || '';
    const domInventory = collected.inventory || inventoryFromDom(document);
    const domChars = countPlainChars(domInventory.plain || '');

    try {
      progress('读取全量文档数据…', 46);
      const model = await loadDocModel((t, p) => progress(t, p));
      if (model && model.plain) modelPlainForGate = model.plain;
      if (shouldPreferModel(model, domInventory, collected.html)) {
        if (model.issues && model.issues.length) {
          const e = new Error('全量文档数据不完整，已中止以免生成残缺文档');
          e.detail = model.issues.join('\n')
            + '\n（已拉嵌套请求 ' + (model.skipRequests || 0)
            + ' 次；缺失表格单元格 ' + (model.missingTableCells || 0) + '）';
          throw e;
        }
        // 模型可能丢 drive-stream PDF 链：后面用 domHtmlBackup 回填
        collected = {
          html: model.html,
          mediaMap: model.mediaMap,
          inventory: model.inventory,
          salvaged: 0,
          domHtml: domHtmlBackup
        };
        fromModel = true;
        modelSnap = model.snapshot;
        // 仅模型路径用模型样式指纹；DOM 路径不可串用（会误报标题级别）
        srcStyleAtoms = model.styleAtoms || [];
        srcStyleStructure = model.styleStructure || null;
        detail('采用全量文档数据（' + countPlainChars(model.plain) + ' 字 / '
          + (model.blocks || 0) + ' 块；页面采集 ' + domChars + ' 字）。');
      } else if (model) {
        srcStyleAtoms = [];
        srcStyleStructure = null;
        if (model.issues && model.issues.length) {
          detail('文档数据告警（未采用）：' + model.issues[0]);
        }
        // 页面路径也要把模型里更长的代码块灌进去，防虚拟列表少字
        const merged = mergeLongerCodesIntoHtml(collected.html, model);
        if (merged.added) {
          collected.html = merged.html;
          detail('已从文档数据补入 ' + merged.added + ' 个更完整的代码块。');
        }
        // 门禁用模型代码全文（含 full），避免 DOM inventory 只有 3 行 needle
        if (model.inventory && model.inventory.codes && model.inventory.codes.length) {
          collected.inventory = Object.assign({}, collected.inventory || domInventory, {
            codes: model.inventory.codes
          });
        }
        detail('页面采集更完整或数据半残，沿用页面结果（页面 '
          + domChars + ' 字 / 数据 ' + countPlainChars(model.plain) + ' 字）。');
      } else {
        detail('文档数据不可用，沿用页面采集（' + domChars + ' 字）。');
      }
    } catch (e) {
      if (e && /全量文档数据不完整/.test(e.message || '')) throw e;
      detail('文档数据读取失败，沿用页面采集：' + (e && e.message ? e.message : e));
    }

    let fromModelHtml = fromModel;
    let html = collected.html;
    // 文首说明：所有路径统一追加（模型路径若已带则不重复）
    if (!/转存时间：/.test(html)) {
      html = transferBannerHtml() + html;
    }
    const expectedLinks = countHtmlLinks(collected.html || '');
    let title = '转存文档';
    try {
      title = await resolveTransferTitle(collected.html || html || '');
    } catch (e) {
      title = docTitle();
    }
    detail('文档标题：' + title);
    html = syncLeadingH1(html, title);
    const inventory = collected.inventory || domInventory;

    const tableCount = (html.match(/<table/g) || []).length;
    const imgCount = (html.match(/<img/g) || []).length;
    const mediaCount = (collected.mediaMap || new Map()).size;
    const failMedia = (html.match(/【素材】/g) || []).length;
    const mediaMapSize = (collected.mediaMap && collected.mediaMap.size) || 0;
    // 模型路径丢链时，用页面采集的 a 标签按锚文回填
    const linkSrcHtml = collected.domHtml || domHtmlBackup || '';
    if (linkSrcHtml && countHtmlLinks(linkSrcHtml) > countHtmlLinks(html)) {
      const before = countHtmlLinks(html);
      html = salvageDomLinksIntoHtml(html, linkSrcHtml);
      const added = countHtmlLinks(html) - before;
      if (added > 0) detail('已从页面采集回填 ' + added + ' 个链接。');
    }
    const mr = await resolveMediaBlocks(html, collected.mediaMap || new Map(), (t, p) => progress(t, p));
    html = mr.html;
    const uploadedVideos = mr.videos || [];
    // drive-stream 预览链 → /file/token（否则 parse_html 会剥成纯文本）
    html = normalizeHtmlLinksInPlace(html);
    // 自审计：素材占位应清掉；附件应带可点链接
    const leftPh = (html.match(/data-fxfer-media=/g) || []).length;
    const fileLinkN = (html.match(/【(?:PDF|附件|视频|文件)】[\s\S]{0,80}<a\s[^>]*href=/gi) || []).length
      + (html.match(/<a\s[^>]*href=["'][^"']+\/file\/[^"']+["']/gi) || []).length;
    const driveLeft = (html.match(/internal-api-drive-stream|\/stream\/download\//gi) || []).length;
    if (leftPh) detail('警告：仍有 ' + leftPh + ' 个素材占位未解析。');
    if (driveLeft) detail('警告：仍有 ' + driveLeft + ' 处 drive-stream 链未改写为 /file/。');
    if (mediaMapSize > 0 && fileLinkN < 1) {
      detail('警告：源有 ' + mediaMapSize + ' 个附件/素材，转存结果里未见可点文件链接。');
    } else if (mediaMapSize > 0) {
      detail('附件/素材链接已保留 ' + fileLinkN + ' 处（源登记 ' + mediaMapSize + '）。');
    }
    const fileLike = HN ? HN.countFileLikeLinks(html) : fileLinkN;
    if (fileLike < 1 && countHtmlLinks(linkSrcHtml) >= DOM_ENOUGH_LINKS) {
      detail('警告：源页有多处链接，提交 HTML 中文件/跳转链偏少（' + fileLike + '）。');
    }

    const ie = await embedImages(html, (t, p) => progress(t, p));
    html = ie.html;

    let full = '<html><head><meta charset="utf-8"><title>' + title + '</title></head><body>' + html + '</body></html>';
    let fullBytes = new TextEncoder().encode(full).length;
    if (fullBytes > HTML_SOFT_TARGET) {
      const target = Math.min(HTML_SOFT_TARGET, MAX_HTML_BYTES * 0.95);
      progress('文档约 ' + (fullBytes / 1048576).toFixed(1) + 'MB，正在压缩大图…', 70);
      const sh = await shrinkEmbeddedHtml(full, target, (t, p) => progress(t, p));
      full = sh.html;
      fullBytes = new TextEncoder().encode(full).length;
      detail('压缩后 HTML ' + (fullBytes / 1048576).toFixed(2) + 'MB'
        + (sh.shrunk ? '（再压 ' + sh.shrunk + ' 张）' : '')
        + (sh.dropped ? '（跳过 ' + sh.dropped + ' 张大图）' : '')
        + '…');
    } else {
      detail('HTML ' + (fullBytes / 1048576).toFixed(2) + 'MB（分块上传）…');
    }

    // 提交前硬门禁：代码块/标题缺失则中止（不做展示型对比报告）
    const preAudit = auditInventories(inventory, full);
    const criticalMissing = preAudit.missing.filter(m => m.kind === '代码块' || m.kind === '标题');
    if (criticalMissing.length) {
      progress('发现关键内容缺失，已中止上传…', 72);
      const e = new Error('采集结果缺少 ' + criticalMissing.length + ' 处代码块/标题，已中止以免生成残缺文档');
      e.detail = '请刷新页面后重试。';
      throw e;
    }

    // 上传前字数门禁（静默基准，不展示对比报告）
    let srcSnap = modelSnap;
    if (!srcSnap) {
      try { srcSnap = await captureDocSnapshot(null); } catch (e) { srcSnap = null; }
    }
    if ((!srcStyleAtoms || !srcStyleAtoms.length) && srcSnap) {
      srcStyleAtoms = srcSnap.styleAtoms || (SF ? SF.atomsFromStyleSamples(srcSnap.styles || []) : []);
    }
    if (!srcStyleStructure && SF) {
      srcStyleStructure = SF.extractAtomsFromHtml(
        (collected && collected.html) || html || ''
      ).structure;
    }

    const htmlInv = inventoryFromHtml(full);
    const htmlChars = countPlainChars(htmlInv.plain || '');
    const htmlImgs = (String(full).match(/<img[\s>]/gi) || []).length;
    // 禁止提交空文档：正文无字且无图则中止（此前半残文档数据会导致整篇空白）
    if (htmlChars < 1 && htmlImgs < 1) {
      progress('待上传内容为空，已中止…', 74);
      const e = new Error('待上传 HTML 正文为空，已中止，避免生成空白文档');
      e.detail = '页面采集与文档数据均未得到可用正文。请刷新后重试；若仍失败，把文档链接发我。';
      throw e;
    }
    // 链接门禁：课表类文档几乎全是文档引用；链接大量丢失时中止，避免生成「空壳」
    const fullLinks = countHtmlLinks(full);
    if (expectedLinks >= DOM_ENOUGH_LINKS && fullLinks < Math.ceil(expectedLinks * LINK_RATIO_ABORT)) {
      progress('待上传链接丢失过多，已中止…', 74);
      const e = new Error('待上传 HTML 仅保留 ' + fullLinks + '/' + expectedLinks + ' 个链接，已中止');
      e.detail = '采集阶段有 ' + expectedLinks + ' 个链接，提交前只剩 ' + fullLinks
        + ' 个。请刷新后重试；若仍失败，把文档链接发我。';
      throw e;
    }
    const srcCharsForGate = (srcSnap && srcSnap.counts && srcSnap.counts.chars)
      || countPlainChars(inventory.plain || '')
      || countPlainChars(modelPlainForGate || '');
    if (srcCharsForGate > 0) {
      if (htmlChars < srcCharsForGate * CHAR_RATIO_ABORT) {
        progress('待上传内容字数不足，已中止…', 74);
        const e = new Error('待上传内容仅保留原文 '
          + Math.round((htmlChars / srcCharsForGate) * 100) + '% 的字数，已中止以免生成残缺文档');
        e.detail = '原文 ' + srcCharsForGate + ' 字，待上传 ' + htmlChars + ' 字。请刷新后重试。';
        throw e;
      }
    }

    // 逐行门禁：优先用模型纯文本（干净）；否则快照。目标字数更多时不因换行合并误杀
    const gateSrcPlain = modelPlainForGate
      || (fromModelHtml && srcSnap && srcSnap.plain)
      || (srcSnap && srcSnap.plain)
      || (inventory && inventory.plain)
      || '';
    if (gateSrcPlain && countPlainChars(gateSrcPlain) >= 20) {
      const fid = charLineFidelity(gateSrcPlain, htmlInv.plain || '');
      if (!fid.ok) {
        progress('逐行核对未通过，已中止…', 74);
        const miss = (fid.missingLines || []).slice(0, 8).map(x =>
          'L' + x.index + '(' + x.chars + '字): ' + x.text
        ).join('\n');
        const e = new Error('逐行逐字核对失败：字数保留 '
          + Math.round(fid.ratio * 100) + '%、行保留 '
          + Math.round(fid.lineRatio * 100) + '%，已中止');
        e.detail = '原文 ' + fid.srcChars + ' 字 / ' + fid.srcLines + ' 行，待上传 '
          + fid.destChars + ' 字。'
          + (miss ? ('\n缺失行示例：\n' + miss) : '')
          + '\n请刷新后重试；若仍失败把文档链接发我。';
        throw e;
      }
      detail('逐行逐字核对通过（' + fid.srcChars + ' 字 / ' + fid.srcLines + ' 行）。');
    }
    // 代码块全文门禁（只在真缺字/缺行时中止；目标更长不算失败）
    const modelCodes = (inventory && inventory.codes) || [];
    const codeMiss = [];
    modelCodes.forEach((c, i) => {
      const codeFull = String((c && c.full) || ((c && c.needle) || []).join('\n') || '');
      if (countPlainChars(codeFull) < 8) return;
      const cf = charLineFidelity(codeFull, htmlInv.plain || '');
      if (!cf.ok) {
        codeMiss.push('代码块' + (i + 1) + ' 仅 ' + Math.round(cf.ratio * 100) + '% / 缺 '
          + (cf.missingLines || []).length + ' 行');
      }
    });
    if (codeMiss.length) {
      progress('代码块逐行核对未通过，已中止…', 74);
      const e = new Error('代码块逐行核对失败（' + codeMiss.length + ' 处），已中止以免少字');
      e.detail = codeMiss.slice(0, 6).join('\n') + '\n请刷新后重试。';
      throw e;
    }

    // 样式：尽量自动改正；改不完只告警继续上传（内容门禁已守住字/链/代码）
    if (SF && srcStyleAtoms && srcStyleAtoms.length) {
      progress('内容+样式比对并自动改正…', 75);
      const bodyMatch = String(full).match(/<body[^>]*>([\s\S]*)<\/body>/i);
      const bodyHtml = bodyMatch ? bodyMatch[1] : full;
      const fixed = SF.compareAndFix(srcStyleAtoms, srcStyleStructure, bodyHtml);
      if (fixed.patched) {
        detail('样式自动改正 ' + fixed.patched + ' 处（轮次 ' + fixed.rounds + '）。');
      }
      if (bodyMatch) {
        full = String(full).replace(/<body([^>]*)>[\s\S]*<\/body>/i, '<body$1>' + fixed.html + '</body>');
      } else {
        full = fixed.html;
      }
      if (!fixed.ok) {
        const miss = (fixed.missing || []).slice(0, 4).map(x =>
          (x.issue || '样式差') + '：「' + (x.text || '').slice(0, 30) + '」'
        ).join('；');
        detail('样式仍有差异（已尽量改正，继续上传）'
          + (miss ? '：' + miss : '')
          + ((fixed.structWarn || []).length ? '；结构告警 ' + fixed.structWarn.length : ''));
      } else {
        detail('内容+样式比对通过（原子 ' + srcStyleAtoms.length + '，改正 '
          + (fixed.patched || 0) + '）。');
      }
    } else if (SF) {
      detail('源样式指纹为空，跳过样式改正（仅内容门禁）。');
    }

    const ticket = await submitParseHtml(full, title, (t, p) => progress(t, p));
    const docUrl = await pollResult(ticket, (t, p) => progress(t, p));
    detail('文档已生成'
      + (imgCount ? ' · 图 ' + imgCount : '')
      + (tableCount ? ' · 表 ' + tableCount : '')
      + (uploadedVideos.length ? ' · 视频 ' + uploadedVideos.length : '')
      + (failMedia ? ' · 部分素材失败' : ''));
    const preCharsOk = !(srcSnap && srcSnap.counts && srcSnap.counts.chars)
      || htmlChars + CHAR_ABS_SLACK >= srcSnap.counts.chars
      || htmlChars >= srcSnap.counts.chars * CHAR_RATIO_WARN;
    return {
      docUrl,
      videos: uploadedVideos,
      fromModel: fromModelHtml,
      preCharsOk
    };
  }

  /* ---------------- 视频注入配合（新文档页 / 后台 CDP 执行） ---------------- */

  async function locatePlaceholder(index) {
    const idx = (typeof index === 'number' && index >= 0) ? index : 0;
    // 只取"承载【视频】文字的小块"：大容器整篇文本里也含这三个字，会把坐标算飞
    const find = () => [...document.querySelectorAll('[data-block-id]')].filter(x => {
      const t = (x.innerText || '').replace(/\s+/g, ' ');
      return t.includes('【视频】') && t.trim().length < 160;
    });
    let els = [];
    for (let i = 0; i < 40; i++) {
      els = find();
      if (els.length > idx) break;
      const sc = document.querySelector('.bear-web-x-container');
      if (!sc) break;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.floor(sc.clientHeight * 0.7));
      await sleep(400);
    }
    const el = els[idx] || els[0];
    if (!el) {
      const sc = document.querySelector('.bear-web-x-container');
      if (!sc) return { found: false };
      sc.scrollTop = sc.scrollHeight;                 // 兜底：滚到文末，视频落在结尾
      await sleep(900);
      const blocks = [...document.querySelectorAll('[data-block-id]')];
      const last = blocks[blocks.length - 1];
      if (!last) return { found: false };
      const lr = last.getBoundingClientRect();
      return { found: false, x: Math.round(lr.left + lr.width / 2), y: Math.round(lr.top + lr.height / 2) };
    }
    // 飞书用自定义滚动容器，scrollIntoView 无效，直接设置容器的 scrollTop
    const sc = document.querySelector('.bear-web-x-container');
    try {
      if (sc) {
        const absTop = el.getBoundingClientRect().top + sc.scrollTop;
        sc.scrollTop = Math.max(0, Math.round(absTop - sc.clientHeight / 2));
      } else {
        el.scrollIntoView({ block: 'center' });
      }
    } catch (e) { }
    await sleep(1000);                      // 等滚动稳定后再量坐标
    const r = el.getBoundingClientRect();
    if (r.top < 40 || r.top > (window.innerHeight - 40)) {
      return { found: false, x: Math.round(r.left + r.width / 2), y: Math.max(60, Math.round(r.top + 10)) };
    }
    // 落点取段落左边缘内侧（占位段落里可能含链接，点在链接上编辑器不落光标）
    return { found: true, x: Math.round(r.left + 4), y: Math.round(r.top + Math.min(18, Math.max(8, r.height / 2))) };
  }

  function showInsertResult(count) {
    const ui = openPanel();
    ui.status('✅ 视频已作为播放块插入本文档（' + (count || 1) + ' 个）', 100);
    ui.result('视频已落在原文档对应位置附近；如需微调可直接拖动该视频块。');
  }

  async function auditScanCurrentDoc() {
    const snapshot = await captureDocSnapshot();
    const inv = inventoryFromDom(document);
    const plain = snapshot.plain || stripInvisible((document.body.innerText || '').replace(/\u00a0/g, ' '));
    return {
      inventory: Object.assign({}, inv, {
        plain,
        tables: Math.max(inv.tables || 0, (snapshot.counts && snapshot.counts.tables) || 0),
        images: Math.max(inv.images || 0, (snapshot.counts && snapshot.counts.images) || 0)
      }),
      snapshot
    };
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'fxfer-locate') { locatePlaceholder(msg.index).then(r => sendResponse(r || { found: false })); return true; }
      if (msg.type === 'fxfer-inserted') { showInsertResult(msg.count); }
      if (msg.type === 'fxfer-audit-scan') {
        auditScanCurrentDoc().then(r => sendResponse({
          ok: true,
          inventory: r.inventory,
          snapshot: r.snapshot
        }))
          .catch(e => sendResponse({ ok: false, error: String(e && e.message || e) }));
        return true;
      }
    });
  } catch (e) { }

  /* ---------------- 启动 ---------------- */

  const boot = () => ensureButton();
  boot();
  // 飞书是 SPA：轮询监听路由变化，切换页面时更新按钮状态
  setInterval(boot, 1500);
})();
