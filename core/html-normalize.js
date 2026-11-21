/**
 * 转存 HTML 规范化：链接（drive-stream → /file/token）、飞书 textHighlight 颜色。
 * 浏览器：globalThis.FxferHtmlNormalize；Node：module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FxferHtmlNormalize = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* 飞书 CCM 常用字色（与编辑器 textHighlight / doc-textcolor 对齐） */
  const FEISHU_TEXT_COLORS = {
    red: '#d83931',
    pink: '#d83931',
    'pink-text': '#d83931',
    orange: '#de7802',
    yellow: '#dc9b04',
    green: '#2ea121',
    blue: '#245bdb',
    purple: '#6421f2',
    gray: '#646a73',
    grey: '#646a73',
    indigo: '#4752e6',
    teal: '#049fd7',
    magenta: '#e01e5a'
  };

  const FEISHU_BG_COLORS = {
    light_red: '#fdd4d1',
    light_orange: '#fdecc8',
    light_yellow: '#fef2c4',
    light_green: '#d2f0cd',
    light_blue: '#d0e3ff',
    light_purple: '#e0d5ff',
    light_gray: '#eff0f1',
    light_grey: '#eff0f1',
    light_pink: '#fdd4d1'
  };

  function driveTokenFromHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return '';
    let h = raw;
    try { h = decodeURIComponent(raw); } catch (e) { h = raw; }
    let m = h.match(/\/(?:box\/)?stream\/download\/(?:v2\/)?(?:cover|all|preview)\/([A-Za-z0-9]{16,40})/i);
    if (m) return m[1];
    m = h.match(/\/file\/([A-Za-z0-9]{16,40})/i);
    if (m) return m[1];
    m = h.match(/[?&](?:file_token|token)=([A-Za-z0-9]{16,40})/i);
    if (m) return m[1];
    return '';
  }

  function isDriveStreamHref(href) {
    return /internal-api-drive-stream|\/stream\/download\/|(?:^|\/)file\/[A-Za-z0-9]{16,}/i.test(String(href || ''));
  }

  function absolutizeHref(href, origin) {
    const h = String(href || '').trim();
    if (!h) return '';
    if (/^https?:\/\//i.test(h) || /^mailto:/i.test(h)) return h;
    if (h.charAt(0) === '/') {
      const o = String(origin || '').replace(/\/$/, '');
      return o ? (o + h) : h;
    }
    return h;
  }

  /**
   * parse_html 会丢掉 internal-api-drive-stream 预览链；改成同源 /file/token 才能保住可点链接。
   */
  function normalizeHrefForParse(href, origin) {
    const tok = driveTokenFromHref(href);
    if (tok) return absolutizeHref('/file/' + tok, origin);
    return absolutizeHref(href, origin);
  }

  function mapFeishuColorToken(token) {
    const t = String(token || '').trim().toLowerCase()
      .replace(/^texthighlight[-_]?/i, '')
      .replace(/^ccmtoken-doc-textcolor[-_]?/i, '')
      .replace(/^doc-textcolor[-_]?/i, '');
    if (!t) return '';
    if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return t.length === 4
      ? ('#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3]).toLowerCase()
      : t.toLowerCase();
    if (FEISHU_TEXT_COLORS[t]) return FEISHU_TEXT_COLORS[t];
    if (FEISHU_BG_COLORS[t]) return FEISHU_BG_COLORS[t];
    // pink-text / red-text
    const m = t.match(/^(red|pink|orange|yellow|green|blue|purple|gray|grey|indigo|teal|magenta)(?:-text)?$/);
    if (m && FEISHU_TEXT_COLORS[m[1]]) return FEISHU_TEXT_COLORS[m[1]];
    return '';
  }

  /**
   * 飞书 apool 里 textHighlight:"red"/"pink" 实际是字色；light_* 才是底色。
   */
  function resolveInlineColors(attrs) {
    const a = attrs && typeof attrs === 'object' ? attrs : {};
    let color = a.textColor || a.fontColor || a['font-color'] || a.color || '';
    let bg = a.backgroundColor || a.highlight || a.backColor || a.highlightColor || '';
    const thRaw = a.textHighlight != null ? a.textHighlight
      : (a['text-highlight'] != null ? a['text-highlight'] : '');
    const th = String(thRaw || '').trim();
    if (th) {
      const low = th.toLowerCase();
      if (/^(light_|pale_)/.test(low) || FEISHU_BG_COLORS[low]) {
        bg = bg || mapFeishuColorToken(th) || th;
      } else {
        const mapped = mapFeishuColorToken(th);
        if (mapped) color = color || mapped;
        else if (/^#|^rgb/i.test(th)) color = color || th;
        else color = color || mapFeishuColorToken(th) || '';
      }
    }
    // 类名残留：textHighlight-pink-text
    const cls = String(a.className || a.class || '');
    if (!color && cls) {
      const cm = cls.match(/doc-textcolor[-_]([a-z]+)/i)
        || cls.match(/textHighlight[-_]([a-z]+(?:-text)?)/i);
      if (cm) color = mapFeishuColorToken(cm[1]);
    }
    if (color && !/^#|^rgb/i.test(String(color))) {
      color = mapFeishuColorToken(color) || color;
    }
    if (bg && !/^#|^rgb/i.test(String(bg))) {
      bg = mapFeishuColorToken(bg) || bg;
    }
    return { color: String(color || ''), bg: String(bg || '') };
  }

  function colorFromClassName(cls) {
    const s = String(cls || '');
    if (!s) return '';
    const m = s.match(/doc-textcolor[-_]([a-z]+)/i)
      || s.match(/textHighlight[-_](pink-text|[a-z]+)/i);
    if (!m) return '';
    return mapFeishuColorToken(m[1]);
  }

  function wrapColoredHtml(inner, hex) {
    const h = String(hex || '').trim();
    if (!h || !inner) return inner;
    if (/style\s*=\s*["'][^"']*color\s*:/i.test(inner) || /\scolor\s*=\s*["']#/i.test(inner)) {
      return inner;
    }
    return '<font color="' + h + '"><span style="color:' + h + '" color="' + h + '">'
      + inner + '</span></font>';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /**
   * 代码块着色片段：有字色则包 font+span，否则纯转义。
   * 只应传入「文档标注色」（textHighlight），不要把语法高亮主题色传进来。
   */
  function wrapCodeSegment(text, hex) {
    const raw = String(text == null ? '' : text);
    if (!raw) return '';
    const esc = escapeHtml(raw);
    const h = String(hex || '').trim();
    if (!h || !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(h)) return esc;
    return '<font color="' + h.toLowerCase() + '"><span style="color:' + h.toLowerCase()
      + '" color="' + h.toLowerCase() + '">' + esc + '</span></font>';
  }

  /** 把 [{text, color}] 行数组拼成 <pre><code>…</code></pre> */
  function buildColoredCodeHtml(lines, langClass) {
    const rows = Array.isArray(lines) ? lines : [];
    const body = rows.map(line => {
      if (typeof line === 'string') return escapeHtml(line);
      if (!line) return '';
      if (Array.isArray(line.parts)) {
        return line.parts.map(p => wrapCodeSegment(p.text || p.t || '', p.color || p.hex || '')).join('');
      }
      return wrapCodeSegment(line.text || '', line.color || line.hex || '');
    }).join('\n');
    const lang = String(langClass || '').replace(/[^a-zA-Z0-9_+#.-]/g, '');
    const cls = lang ? (' class="language-' + lang + '"') : '';
    return '<pre style="white-space:pre-wrap;word-break:break-word"><code' + cls + '>'
      + body + '</code></pre>';
  }

  /**
   * 字符串级改写所有 <a href> / data-href，把 drive-stream 预览链改成 /file/token。
   */
  function normalizeHtmlLinks(html, origin) {
    let out = String(html || '');
    const replacer = (full, pre, quote, href, post) => {
      const next = normalizeHrefForParse(href, origin);
      if (!next || next === href) return full;
      return pre + quote + next.replace(/"/g, '&quot;') + quote + post;
    };
    out = out.replace(/(<a\b[^>]*?\bhref\s*=\s*)(["'])([^"']*)\2([^>]*>)/gi, replacer);
    out = out.replace(/(<a\b[^>]*?\bdata-href\s*=\s*)(["'])([^"']*)\2([^>]*>)/gi, (full, pre, quote, href, post) => {
      let decoded = href;
      try { decoded = decodeURIComponent(href); } catch (e) { }
      const next = normalizeHrefForParse(decoded, origin);
      if (!next) return full;
      return pre + quote + next.replace(/"/g, '&quot;') + quote + post;
    });
    return out;
  }

  /** 统计可点链接；drive-stream 未规范化前也算（用于采集门禁） */
  function countHtmlLinks(html) {
    return (String(html || '').match(/<a\s[^>]*\bhref\s*=/gi) || []).length;
  }

  /** 统计「像文件/跳转」的链接（/file/ /wiki/ /docx/ 或原 drive-stream） */
  function countFileLikeLinks(html) {
    const s = String(html || '');
    const re = /<a\s[^>]*\bhref\s*=\s*["']([^"']+)["']/gi;
    let n = 0;
    let m;
    while ((m = re.exec(s))) {
      const h = m[1] || '';
      if (/\/file\/|\/wiki\/|\/docx\/|drive-stream|\/download\/(?:preview|all)|\.pdf(?:\?|#|$)/i.test(h)) n++;
    }
    return n;
  }

  const MEDIA_ID_RE = /data-fxfer-media=["']([A-Za-z0-9_-]+)["']/g;

  function listMediaPlaceholderIds(html) {
    const ids = [];
    const re = new RegExp(MEDIA_ID_RE.source, 'g');
    let m;
    while ((m = re.exec(String(html || '')))) ids.push(m[1]);
    return [...new Set(ids)];
  }

  function replaceMediaPlaceholder(html, id, block) {
    const needle = '<div data-fxfer-media="' + id + '"></div>';
    return String(html || '').split(needle).join(block == null ? '' : block);
  }

  return {
    FEISHU_TEXT_COLORS,
    FEISHU_BG_COLORS,
    driveTokenFromHref,
    isDriveStreamHref,
    absolutizeHref,
    normalizeHrefForParse,
    mapFeishuColorToken,
    resolveInlineColors,
    colorFromClassName,
    wrapColoredHtml,
    escapeHtml,
    wrapCodeSegment,
    buildColoredCodeHtml,
    normalizeHtmlLinks,
    countHtmlLinks,
    countFileLikeLinks,
    listMediaPlaceholderIds,
    replaceMediaPlaceholder,
    MEDIA_ID_RE
  };
});
