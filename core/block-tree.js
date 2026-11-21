/**
 * 飞书 block_map 纯函数（Node 自测 + content script 共用）。
 * Copyright (c) 2026 sa
 * 浏览器：挂到 globalThis.FxferBlockTree；Node：module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.FxferBlockTree = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DOM_ENOUGH_LINKS = 3;
  const LINK_RATIO_ABORT = 0.7;
  const CHAR_ABS_SLACK = 3;

  function blockBody(raw) {
    if (!raw || typeof raw !== 'object') return null;
    let b = raw.data || raw.snapshot || raw;
    if (b && b.data && typeof b.data === 'object' && b.data.type && !b.type) b = b.data;
    if (b && b.snapshot && typeof b.snapshot === 'object' && b.snapshot.type) b = b.snapshot;
    return b && typeof b === 'object' ? b : null;
  }

  /** children 可能是数组 / {default:[...]} / 缺失 */
  function normalizeChildrenList(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
      return raw
        .map(x => (typeof x === 'string' ? x : (x && (x.id || x.block_id)) || ''))
        .filter(Boolean);
    }
    if (typeof raw === 'object') {
      const out = [];
      const seen = new Set();
      Object.values(raw).forEach(v => {
        if (!Array.isArray(v)) return;
        v.forEach(x => {
          const id = typeof x === 'string' ? x : (x && (x.id || x.block_id)) || '';
          if (id && !seen.has(id)) {
            seen.add(id);
            out.push(id);
          }
        });
      });
      return out;
    }
    return [];
  }

  function childIds(body) {
    if (!body || typeof body !== 'object') return [];
    return normalizeChildrenList(body.children || body.child_ids);
  }

  function readChildrenFromEntry(entry) {
    if (!entry || typeof entry !== 'object') return [];
    if (entry.children != null || entry.child_ids != null) {
      return normalizeChildrenList(entry.children || entry.child_ids);
    }
    const data = entry.data;
    if (data && typeof data === 'object') {
      return normalizeChildrenList(data.children || data.child_ids);
    }
    return [];
  }

  function writeChildrenToEntry(entry, kids) {
    if (!entry || typeof entry !== 'object') return;
    if (entry.data && typeof entry.data === 'object') {
      entry.data = Object.assign({}, entry.data, { children: kids });
      return;
    }
    entry.children = kids;
  }

  /** 翻页合并：已有条目的 children 取并集（保持先见顺序） */
  function mergeBlockMap(into, add) {
    if (!into || !add) return;
    Object.keys(add).forEach(id => {
      const entry = add[id];
      const prev = into[id];
      if (!prev) {
        into[id] = entry;
        return;
      }
      const kids = readChildrenFromEntry(prev).slice();
      const seen = new Set(kids);
      readChildrenFromEntry(entry).forEach(c => {
        if (!seen.has(c)) {
          seen.add(c);
          kids.push(c);
        }
      });
      // 新字段覆盖旧字段，但 children 强制用并集
      const merged = Object.assign({}, prev, entry);
      if (prev.data || (entry && entry.data)) {
        const prevData = (prev.data && typeof prev.data === 'object') ? prev.data : {};
        const addData = (entry && entry.data && typeof entry.data === 'object') ? entry.data : {};
        merged.data = Object.assign({}, prevData, addData, { children: kids });
        if ('children' in merged && merged.data) delete merged.children;
      } else {
        merged.children = kids;
      }
      into[id] = merged;
    });
  }

  /**
   * 长文翻页后根块 children 可能不全：把 parent 仍是根、却不在 children 里的块
   * 按 block_sequence 顺序补到末尾。
   */
  function patchRootChildren(blockMap, rootId, sequence) {
    if (!blockMap || !rootId || !blockMap[rootId]) return 0;
    const body = blockBody(blockMap[rootId]);
    if (!body) return 0;
    const kids = childIds(body).slice();
    const seen = new Set(kids);
    let added = 0;
    const candidates = Array.isArray(sequence) && sequence.length
      ? sequence.map(String)
      : Object.keys(blockMap);
    candidates.forEach(id => {
      if (!id || seen.has(id) || id === rootId || !blockMap[id]) return;
      const b = blockBody(blockMap[id]);
      if (!b) return;
      const parent = String(b.parent_id || b.parentId || '');
      if (parent !== String(rootId)) return;
      seen.add(id);
      kids.push(id);
      added++;
    });
    if (added) writeChildrenToEntry(blockMap[rootId], kids);
    return added;
  }

  function tableLayout(body) {
    if (!body || typeof body !== 'object') {
      return { rows: [], cols: [], cellSet: null, columnSet: {} };
    }
    const bag = (body.table && typeof body.table === 'object') ? body.table : body;
    const rows = Array.isArray(bag.rows_id) ? bag.rows_id.map(String) : [];
    const cols = Array.isArray(bag.columns_id) ? bag.columns_id.map(String) : [];
    const cellSet = (bag.cell_set && typeof bag.cell_set === 'object') ? bag.cell_set : null;
    const columnSet = (bag.column_set && typeof bag.column_set === 'object') ? bag.column_set : {};
    return { rows, cols, cellSet, columnSet };
  }

  function tableCellTokens(layout) {
    if (!layout || !layout.cellSet) return [];
    const out = [];
    const seen = new Set();
    Object.keys(layout.cellSet).forEach(k => {
      const raw = layout.cellSet[k];
      const id = typeof raw === 'string' ? raw : (raw && (raw.block_id || raw.blockId)) || '';
      if (id && !seen.has(id)) {
        seen.add(id);
        out.push(String(id));
      }
    });
    return out;
  }

  function missingTableCellIds(blockMap) {
    if (!blockMap) return [];
    const miss = [];
    Object.keys(blockMap).forEach(id => {
      const body = blockBody(blockMap[id]);
      if (!body || String(body.type || '') !== 'table') return;
      tableCellTokens(tableLayout(body)).forEach(cid => {
        if (!blockMap[cid]) miss.push(cid);
      });
    });
    return miss;
  }

  function missingSkipIds(skipped, blockMap) {
    const out = [];
    if (!skipped) return out;
    skipped.forEach(id => {
      const s = String(id);
      if (s && (!blockMap || !blockMap[s])) out.push(s);
    });
    return out;
  }

  function absorbPart(blockMap, skipped, sequence, seqSeen, part) {
    if (!part || !part.blockMap) return 0;
    const before = Object.keys(blockMap).length;
    mergeBlockMap(blockMap, part.blockMap);
    (part.skipBlocks || []).forEach(id => skipped.add(String(id)));
    (part.sequence || []).forEach(id => {
      const s = String(id);
      if (!seqSeen.has(s)) {
        seqSeen.add(s);
        sequence.push(s);
      }
    });
    return Object.keys(blockMap).length - before;
  }

  function completenessIssues(opts) {
    const o = opts || {};
    const issues = [];
    if (o.pagingHitLimit) {
      issues.push('文档翻页达到上限仍有后续，正文可能被截断');
    }
    if (o.pagingStoppedEarly) {
      issues.push('文档翻页提前结束但服务端仍标记有后续，正文可能不完整');
    }
    const skipN = Number(o.skipRemaining) || 0;
    if (skipN > 0) {
      issues.push('仍有 ' + skipN + ' 个嵌套子树（含表格单元格）未拉全，区块文本可能丢失');
    }
    const cellN = Number(o.missingTableCells) || 0;
    if (cellN > 0) {
      issues.push('表格中有 ' + cellN + ' 个单元格块缺失，表内文字可能为空');
    }
    return issues;
  }

  function countPlainChars(s) {
    return String(s || '').replace(/\s+/g, '').length;
  }

  function countHtmlLinks(html) {
    return (String(html || '').match(/<a\s[^>]*\bhref\s*=/gi) || []).length;
  }

  function shouldPreferModel(model, domInventory, domHtml) {
    if (!model) return false;
    const modelChars = countPlainChars(model.plain || '');
    const modelLines = (model.snapshot && model.snapshot.counts && model.snapshot.counts.lines) || 0;
    const modelImgs = model.images || 0;
    const modelLinks = countHtmlLinks(model.html || '');
    const modelCodes = (model.inventory && model.inventory.codes && model.inventory.codes.length) || 0;
    const modelCodeChars = ((model.inventory && model.inventory.codes) || []).reduce((s, c) => {
      const full = (c && c.full) || ((c && c.needle) || []).join('\n') || (c && c.preview) || '';
      return s + countPlainChars(full);
    }, 0);
    if (modelChars < 8 && modelImgs < 1) return false;
    if (modelLines < 2 && modelImgs < 1 && modelLinks < 1 && modelCodes < 1) return false;
    const domChars = countPlainChars((domInventory && domInventory.plain) || '');
    const domLinks = countHtmlLinks(domHtml || '');
    const domCodes = (domInventory && domInventory.codes && domInventory.codes.length) || 0;
    // 代码块：模型带全量 textField，DOM 常因虚拟列表少行——有代码时优先模型
    if (modelCodes > 0 && modelCodes >= domCodes && modelChars >= Math.floor(domChars * 0.55)) return true;
    if (modelCodeChars > 80 && modelChars >= Math.floor(domChars * 0.55)) return true;
    // 课表/目录类：几乎全是文档链接，模型能还原 mention → 优先模型
    if (modelLinks >= DOM_ENOUGH_LINKS && modelLinks + 1 >= Math.ceil(domLinks * LINK_RATIO_ABORT)
      && modelChars >= Math.floor(domChars * 0.55)) return true;
    if (domChars > 0 && modelChars + CHAR_ABS_SLACK < Math.floor(domChars * 0.85)) return false;
    if (domLinks >= DOM_ENOUGH_LINKS && modelLinks + 1 < Math.ceil(domLinks * LINK_RATIO_ABORT)) return false;
    if (modelChars + CHAR_ABS_SLACK >= domChars) return true;
    if (modelLinks > domLinks && modelChars >= Math.floor(domChars * 0.9)) return true;
    return false;
  }

  return {
    blockBody,
    childIds,
    readChildrenFromEntry,
    mergeBlockMap,
    patchRootChildren,
    tableLayout,
    tableCellTokens,
    missingTableCellIds,
    missingSkipIds,
    absorbPart,
    completenessIssues,
    shouldPreferModel,
    countPlainChars,
    countHtmlLinks,
    DOM_ENOUGH_LINKS,
    LINK_RATIO_ABORT,
    CHAR_ABS_SLACK
  };
});
