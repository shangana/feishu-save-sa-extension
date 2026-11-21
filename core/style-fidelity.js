/**
 * 内容+样式指纹：从 HTML 抽原子 → 与源比对 → 自动补样式 → 再审。
 * 浏览器：globalThis.FxferStyleFidelity；Node：module.exports。
 *
 * 目标边界（诚实）：
 * - 可对齐：正文/标题/列表/引用、加粗/斜体/下划线/删除线、字色/底色、链接、行内代码、代码块全文
 * - 不可保证像素级：画板/多维表/同步块等飞书私有块、字体族/行高/精确排版（parse_html 能力上限）
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FxferStyleFidelity = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const STYLE_FIX_MAX_ROUNDS = 3;
  const STYLE_MISS_ABORT = 1; // 改正后仍有 ≥1 处关键样式缺失 → 中止

  function stripTags(s) {
    return String(s || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
  }

  function normText(s) {
    return String(s || '')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim();
  }

  function escapeRe(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseRgb(c) {
    if (!c) return null;
    const m = String(c).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (m) return { r: +m[1], g: +m[2], b: +m[3] };
    const hex = String(c).trim();
    const h = hex.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!h) return null;
    let x = h[1];
    if (x.length === 3) x = x[0] + x[0] + x[1] + x[1] + x[2] + x[2];
    return {
      r: parseInt(x.slice(0, 2), 16),
      g: parseInt(x.slice(2, 4), 16),
      b: parseInt(x.slice(4, 6), 16)
    };
  }

  function colorKey(c) {
    const p = parseRgb(c);
    if (!p) return String(c || '').toLowerCase().replace(/\s+/g, '');
    return [p.r, p.g, p.b].join(',');
  }

  function rgbToHex(c) {
    const p = parseRgb(c);
    if (!p) {
      const s = String(c || '').trim();
      if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s)) return s.length === 4
        ? ('#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]).toLowerCase()
        : s.toLowerCase();
      return s;
    }
    return '#' + [p.r, p.g, p.b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  function isNearBlack(c) {
    const p = parseRgb(c);
    return p ? (p.r + p.g + p.b) < 60 : false;
  }

  function isNearWhite(c) {
    const p = parseRgb(c);
    return p ? (p.r + p.g + p.b) > 720 : false;
  }

  function emptyAtom(text, block) {
    return {
      text: normText(text).slice(0, 80),
      block: block || '',
      bold: false,
      italic: false,
      underline: false,
      strike: false,
      code: false,
      link: false,
      color: '',
      bg: ''
    };
  }

  function atomSig(a) {
    return [
      a.text,
      a.block || '',
      a.bold ? 1 : 0,
      a.italic ? 1 : 0,
      a.underline ? 1 : 0,
      a.strike ? 1 : 0,
      a.code ? 1 : 0,
      a.link ? 1 : 0,
      a.color || '',
      a.bg || ''
    ].join('|');
  }

  function mergeFlags(into, flags) {
    if (!into || !flags) return into;
    if (flags.bold) into.bold = true;
    if (flags.italic) into.italic = true;
    if (flags.underline) into.underline = true;
    if (flags.strike) into.strike = true;
    if (flags.code) into.code = true;
    if (flags.link) into.link = true;
    if (flags.color && !into.color) into.color = flags.color;
    if (flags.bg && !into.bg) into.bg = flags.bg;
    if (flags.block && !into.block) into.block = flags.block;
    return into;
  }

  function flagsFromOpenTags(stack) {
    const f = emptyAtom('', '');
    stack.forEach(t => {
      const n = t.name;
      if (n === 'strong' || n === 'b') f.bold = true;
      if (n === 'em' || n === 'i') f.italic = true;
      if (n === 'u') f.underline = true;
      if (n === 's' || n === 'strike' || n === 'del') f.strike = true;
      if (n === 'code') f.code = true;
      if (n === 'a') f.link = true;
      if (n === 'h1' || n === 'h2' || n === 'h3' || n === 'h4' || n === 'h5' || n === 'h6') f.block = n;
      if (n === 'li') f.block = f.block || 'li';
      if (n === 'blockquote') f.block = f.block || 'quote';
      if (n === 'pre') f.block = 'pre';
      if (t.color) f.color = t.color;
      if (t.bg) f.bg = t.bg;
    });
    return f;
  }

  function parseStyleAttr(style) {
    const out = { color: '', bg: '' };
    const s = String(style || '');
    const cm = s.match(/(?:^|;)\s*color\s*:\s*([^;]+)/i);
    const bm = s.match(/(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i);
    if (cm) {
      const c = rgbToHex(cm[1].trim());
      if (c && !isNearBlack(c) && !isNearWhite(c)) out.color = colorKey(c);
    }
    if (bm) {
      const b = rgbToHex(bm[1].trim());
      if (b && !isNearWhite(b) && String(bm[1]).toLowerCase() !== 'transparent') out.bg = colorKey(b);
    }
    return out;
  }

  /**
   * 轻量 HTML 扫描：抽「带样式的文本原子」+ 块级角色。
   * 不依赖 DOM，便于 Node 自测。
   */
  function extractAtomsFromHtml(html) {
    const src = String(html || '');
    const atoms = [];
    const seen = new Set();
    const push = (text, flags) => {
      const t = normText(text);
      if (t.length < 2 || t.length > 120) return;
      const a = emptyAtom(t, (flags && flags.block) || '');
      mergeFlags(a, flags);
      // 无任何样式/块角色的纯文本不进样式指纹（内容门禁另管）
      if (!a.bold && !a.italic && !a.underline && !a.strike && !a.code && !a.link
        && !a.color && !a.bg && !a.block) return;
      const k = atomSig(a);
      if (seen.has(k)) return;
      seen.add(k);
      atoms.push(a);
    };

    const stack = [];
    const re = /<\/?([a-zA-Z0-9]+)(\s[^>]*)?>/g;
    let last = 0;
    let m;
    while ((m = re.exec(src))) {
      if (m.index > last) {
        const chunk = stripTags(src.slice(last, m.index));
        if (chunk && /\S/.test(chunk)) {
          const flags = flagsFromOpenTags(stack);
          // 按行拆，避免整段糊成一个原子
          chunk.split(/\n+/).forEach(part => {
            const p = normText(part);
            if (p.length >= 2) push(p.slice(0, 80), flags);
          });
        }
      }
      last = m.index + m[0].length;
      const name = m[1].toLowerCase();
      const isClose = m[0].charAt(1) === '/';
      const selfClose = /\/>$/.test(m[0]) || /^(br|img|hr|meta|input|col)$/i.test(name);
      if (isClose) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].name === name) {
            stack.splice(i, 1);
            break;
          }
        }
        continue;
      }
      if (selfClose) continue;
      const attrs = m[2] || '';
      const styleM = attrs.match(/\sstyle\s*=\s*"([^"]*)"/i) || attrs.match(/\sstyle\s*=\s*'([^']*)'/i);
      const colorAttr = attrs.match(/\scolor\s*=\s*"([^"]*)"/i) || attrs.match(/\scolor\s*=\s*'([^']*)'/i);
      const parsed = parseStyleAttr(styleM ? styleM[1] : '');
      if (colorAttr && !parsed.color) {
        const c = rgbToHex(colorAttr[1]);
        if (c && !isNearBlack(c) && !isNearWhite(c)) parsed.color = colorKey(c);
      }
      stack.push({ name, color: parsed.color, bg: parsed.bg });
    }
    if (last < src.length) {
      const chunk = stripTags(src.slice(last));
      if (chunk && /\S/.test(chunk)) {
        const flags = flagsFromOpenTags(stack);
        chunk.split(/\n+/).forEach(part => {
          const p = normText(part);
          if (p.length >= 2) push(p.slice(0, 80), flags);
        });
      }
    }

    // 结构计数（块级）
    const structure = {
      h1: (src.match(/<h1\b/gi) || []).length,
      h2: (src.match(/<h2\b/gi) || []).length,
      h3: (src.match(/<h3\b/gi) || []).length,
      h4: (src.match(/<h4\b/gi) || []).length,
      h5: (src.match(/<h5\b/gi) || []).length,
      h6: (src.match(/<h6\b/gi) || []).length,
      pre: (src.match(/<pre\b/gi) || []).length,
      table: (src.match(/<table\b/gi) || []).length,
      ul: (src.match(/<ul\b/gi) || []).length,
      ol: (src.match(/<ol\b/gi) || []).length,
      quote: (src.match(/<blockquote\b/gi) || []).length,
      a: (src.match(/<a\s[^>]*\bhref\s*=/gi) || []).length,
      strong: (src.match(/<(strong|b)\b/gi) || []).length,
      em: (src.match(/<(em|i)\b/gi) || []).length
    };

    return { atoms, structure };
  }

  /** 把模型/DOM 样式抽样转成原子 */
  function atomsFromStyleSamples(samples) {
    const atoms = [];
    const seen = new Set();
    (samples || []).forEach(st => {
      if (!st || !st.text) return;
      const a = emptyAtom(st.text, st.block || '');
      a.bold = !!st.bold;
      a.italic = !!st.italic;
      a.underline = !!st.underline;
      a.strike = !!st.strike;
      a.code = !!st.code;
      a.link = !!st.link;
      if (st.color || st.colorRaw) a.color = colorKey(st.colorRaw || st.color);
      if (st.bg || st.bgRaw) a.bg = colorKey(st.bgRaw || st.bg);
      if (!a.bold && !a.italic && !a.underline && !a.strike && !a.code && !a.link && !a.color && !a.bg && !a.block) return;
      const k = atomSig(a);
      if (seen.has(k)) return;
      seen.add(k);
      atoms.push(a);
    });
    return atoms;
  }

  function findDestAtom(src, destAtoms) {
    const list = destAtoms || [];
    // 同文案优先：块级角色一致 → 任意标题 → 精确文本 → 包含关系
    if (src.block && /^h[1-6]$/.test(src.block)) {
      const sameH = list.find(d => d.text === src.text && d.block === src.block);
      if (sameH) return sameH;
      const anyH = list.find(d => d.text === src.text && /^h[1-6]$/.test(d.block || ''));
      if (anyH) return anyH;
    }
    const exact = list.find(d => d.text === src.text);
    if (exact) return exact;
    return list.find(d =>
      d.text && src.text
      && (d.text.indexOf(src.text) >= 0 || src.text.indexOf(d.text) >= 0)
    ) || null;
  }

  function styleFlagsMatch(src, dest) {
    if (!dest) return false;
    if (src.bold && !dest.bold) return false;
    if (src.italic && !dest.italic) return false;
    if (src.underline && !dest.underline) return false;
    if (src.strike && !dest.strike) return false;
    if (src.code && !dest.code) return false;
    if (src.link && !dest.link) return false;
    if (src.color && dest.color && src.color !== dest.color) return false;
    if (src.color && !dest.color) return false;
    if (src.bg && dest.bg && src.bg !== dest.bg) return false;
    if (src.bg && !dest.bg) return false;
    if (src.block && /^h[1-6]$/.test(src.block)) {
      if (dest.block !== src.block) return false;
    }
    if (src.block === 'pre' && dest.block !== 'pre') return false;
    return true;
  }

  function diffStyleAtoms(srcAtoms, destAtoms, destPlain) {
    const missing = [];
    const plain = String(destPlain || '');
    (srcAtoms || []).forEach(src => {
      if (!src || !src.text || src.text.length < 2) return;
      let hit = findDestAtom(src, destAtoms || []);
      // 目标里有纯文本但无样式标记 → 合成空样式原子，才能报出「加粗丢失」而非「未找到」
      if (!hit && plain && plain.indexOf(src.text) >= 0) {
        hit = emptyAtom(src.text, '');
      }
      if (!hit) {
        missing.push({ text: src.text, issue: '带样式原文未找到', want: src, got: null });
        return;
      }
      if (!styleFlagsMatch(src, hit)) {
        const issues = [];
        if (src.bold && !hit.bold) issues.push('加粗丢失');
        if (src.italic && !hit.italic) issues.push('斜体丢失');
        if (src.underline && !hit.underline) issues.push('下划线丢失');
        if (src.strike && !hit.strike) issues.push('删除线丢失');
        if (src.code && !hit.code) issues.push('行内代码丢失');
        if (src.link && !hit.link) issues.push('链接丢失');
        if (src.color && !hit.color) issues.push('颜色丢失');
        if (src.color && hit.color && src.color !== hit.color) issues.push('颜色不一致');
        if (src.bg && !hit.bg) issues.push('底色丢失');
        if (src.block && /^h[1-6]$/.test(src.block) && hit.block !== src.block) issues.push('标题级别不一致');
        if (src.block === 'pre' && hit.block !== 'pre') issues.push('代码块样式丢失');
        missing.push({
          text: src.text,
          issue: issues.join('；') || '样式不一致',
          want: src,
          got: hit
        });
      }
    });
    return missing;
  }

  function diffStructure(srcSt, destSt) {
    const warns = [];
    const keys = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'ul', 'ol', 'quote'];
    keys.forEach(k => {
      const a = (srcSt && srcSt[k]) || 0;
      const b = (destSt && destSt[k]) || 0;
      if (a > 0 && b < a) warns.push(k + '：源 ' + a + ' → 目标 ' + b);
    });
    if ((srcSt && srcSt.a) >= 3 && (destSt && destSt.a) < Math.ceil(srcSt.a * 0.7)) {
      warns.push('链接：源 ' + srcSt.a + ' → 目标 ' + (destSt.a || 0));
    }
    if ((srcSt && srcSt.strong) >= 2 && (destSt && destSt.strong) < Math.ceil(srcSt.strong * 0.7)) {
      warns.push('加粗标记：源 ' + srcSt.strong + ' → 目标 ' + (destSt.strong || 0));
    }
    return warns;
  }

  function replaceFirstUnwrapped(html, text, wrapOpen, wrapClose) {
    const raw = String(html || '');
    const t = String(text || '');
    if (!t) return raw;
    // 已在目标包裹内则跳过
    const wrappedRe = new RegExp(
      wrapOpen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      + '[\\s\\S]{0,40}'
      + escapeRe(t).slice(0, Math.min(40, t.length)),
      'i'
    );
    if (wrappedRe.test(raw)) return raw;
    const idx = raw.indexOf(t);
    if (idx >= 0) {
      return raw.slice(0, idx) + wrapOpen + t + wrapClose + raw.slice(idx + t.length);
    }
    // HTML 实体形式
    const esc = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const idx2 = raw.indexOf(esc);
    if (idx2 >= 0) {
      return raw.slice(0, idx2) + wrapOpen + esc + wrapClose + raw.slice(idx2 + esc.length);
    }
    return raw;
  }

  function promoteToHeading(html, text, level) {
    const t = String(text || '');
    if (!t) return html;
    const lv = Math.min(6, Math.max(1, Number(level) || 1));
    const tag = 'h' + lv;
    // 已是目标级别
    const already = new RegExp('<' + tag + '\\b[^>]*>[\\s\\S]{0,240}?' + escapeRe(t), 'i');
    if (already.test(html)) return html;
    // 错误标题级别 → 改标签（保留内部 markup）
    const wrongH = new RegExp(
      '<h([1-6])(\\s[^>]*)?>([\\s\\S]*?' + escapeRe(t) + '[\\s\\S]*?)<\\/h\\1>',
      'i'
    );
    if (wrongH.test(html)) {
      return html.replace(wrongH, '<' + tag + '$2>$3</' + tag + '>');
    }
    // <p> 内可夹 strong/span 等
    const pRe = new RegExp(
      '<p(\\s[^>]*)?>([\\s\\S]*?' + escapeRe(t) + '[\\s\\S]*?)<\\/p>',
      'i'
    );
    if (pRe.test(html)) {
      return html.replace(pRe, '<' + tag + '>$2</' + tag + '>');
    }
    return replaceFirstUnwrapped(html, t, '<' + tag + '>', '</' + tag + '>');
  }

  /** 按缺失项改正 HTML（能补的补；补不了的留给门禁中止） */
  function patchHtmlStyles(html, mismatches) {
    let out = String(html || '');
    let patched = 0;
    (mismatches || []).forEach(miss => {
      const want = miss.want || {};
      const t = want.text || miss.text || '';
      if (!t || t.length < 2) return;
      const before = out;
      if (want.block && /^h[1-6]$/.test(want.block)) {
        out = promoteToHeading(out, t, Number(want.block.charAt(1)));
      }
      if (want.bold) out = replaceFirstUnwrapped(out, t, '<strong>', '</strong>');
      if (want.italic) out = replaceFirstUnwrapped(out, t, '<em>', '</em>');
      if (want.underline) out = replaceFirstUnwrapped(out, t, '<u>', '</u>');
      if (want.strike) out = replaceFirstUnwrapped(out, t, '<s>', '</s>');
      if (want.code && want.block !== 'pre') out = replaceFirstUnwrapped(out, t, '<code>', '</code>');
      if (want.color) {
        const hex = rgbToHex(want.color.indexOf(',') >= 0
          ? ('rgb(' + want.color + ')')
          : want.color);
        out = replaceFirstUnwrapped(
          out, t,
          '<span style="color:' + hex + '" color="' + hex + '">',
          '</span>'
        );
      }
      if (want.bg) {
        const hex = rgbToHex(want.bg.indexOf(',') >= 0
          ? ('rgb(' + want.bg + ')')
          : want.bg);
        out = replaceFirstUnwrapped(
          out, t,
          '<span style="background-color:' + hex + '">',
          '</span>'
        );
      }
      if (want.block === 'pre') {
        // 若文本在正文里但不在 pre 中，包一层
        if (!new RegExp('<pre[\\s\\S]{0,500}' + escapeRe(t.slice(0, 30)), 'i').test(out)) {
          out = replaceFirstUnwrapped(out, t, '<pre><code>', '</code></pre>');
        }
      }
      if (out !== before) patched++;
    });
    return { html: out, patched };
  }

  function compareAndFix(srcAtoms, srcStructure, html) {
    let cur = String(html || '');
    let rounds = 0;
    let lastMiss = [];
    let totalPatched = 0;
    const plainOf = (h) => normText(stripTags(h));
    for (; rounds < STYLE_FIX_MAX_ROUNDS; rounds++) {
      const dest = extractAtomsFromHtml(cur);
      lastMiss = diffStyleAtoms(srcAtoms, dest.atoms, plainOf(cur));
      const structWarn = diffStructure(srcStructure, dest.structure);
      // 结构计数（h/pre/table）仅告警：文首说明、salvage 会抬高/打散计数，不单凭它判失败
      if (!lastMiss.length) {
        return {
          html: cur,
          ok: true,
          rounds,
          patched: totalPatched,
          missing: [],
          structWarn
        };
      }
      const fix = patchHtmlStyles(cur, lastMiss);
      totalPatched += fix.patched;
      if (fix.patched < 1) {
        return {
          html: cur,
          ok: lastMiss.length < STYLE_MISS_ABORT,
          rounds,
          patched: totalPatched,
          missing: lastMiss,
          structWarn
        };
      }
      cur = fix.html;
    }
    const dest = extractAtomsFromHtml(cur);
    lastMiss = diffStyleAtoms(srcAtoms, dest.atoms, plainOf(cur));
    const structWarn = diffStructure(srcStructure, dest.structure);
    return {
      html: cur,
      ok: lastMiss.length < STYLE_MISS_ABORT,
      rounds,
      patched: totalPatched,
      missing: lastMiss,
      structWarn
    };
  }

  return {
    STYLE_FIX_MAX_ROUNDS,
    stripTags,
    normText,
    colorKey,
    rgbToHex,
    extractAtomsFromHtml,
    atomsFromStyleSamples,
    diffStyleAtoms,
    diffStructure,
    patchHtmlStyles,
    compareAndFix,
    atomSig
  };
});
