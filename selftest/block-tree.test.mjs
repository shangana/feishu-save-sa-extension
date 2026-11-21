/**
 * 区块树完整性自测（Node，无浏览器）。
 * 覆盖：children 对象形态、翻页合并并集、根序补全、表格嵌套、
 * skip 残留判定、选路回归（半残不盖页面 / 长文选模型）。
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const bt = require('../core/block-tree.js');

const failures = [];
let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓', name);
  } catch (e) {
    failures.push({ name, err: e });
    console.log('  ✗', name);
    console.log('   ', e && e.message ? e.message : e);
  }
}

console.log('block-tree selftest');

test('childIds: 数组 children', () => {
  assert.deepEqual(bt.childIds({ children: ['a', 'b'] }), ['a', 'b']);
});

test('childIds: 对象形态 {default:[...]}', () => {
  assert.deepEqual(bt.childIds({ children: { default: ['x', 'y'] } }), ['x', 'y']);
});

test('childIds: 从 entry.data.children 读（对象）', () => {
  const entry = { data: { type: 'page', children: { default: ['p1', 'p2'] } } };
  assert.deepEqual(bt.childIds(bt.blockBody(entry)), ['p1', 'p2']);
});

test('mergeBlockMap: children 并集，不整条覆盖冲掉前页', () => {
  const into = {
    root: { data: { type: 'page', children: ['a', 'b'] } }
  };
  bt.mergeBlockMap(into, {
    root: { data: { type: 'page', children: ['b', 'c'] } }
  });
  assert.deepEqual(bt.childIds(bt.blockBody(into.root)), ['a', 'b', 'c']);
});

test('mergeBlockMap: 新页对象形 children 也能并入', () => {
  const into = {
    root: { data: { type: 'page', children: ['a'] } }
  };
  bt.mergeBlockMap(into, {
    root: { data: { type: 'page', children: { default: ['b'] } } }
  });
  assert.deepEqual(bt.childIds(bt.blockBody(into.root)), ['a', 'b']);
});

test('patchRootChildren: 用 block_sequence 补根下缺失顶层块', () => {
  const map = {
    root: { data: { type: 'page', children: ['a'] } },
    a: { data: { type: 'text', parent_id: 'root', children: [] } },
    b: { data: { type: 'heading1', parent_id: 'root', children: [] } },
    c: { data: { type: 'text', parent_id: 'other', children: [] } }
  };
  const added = bt.patchRootChildren(map, 'root', ['a', 'b', 'c']);
  assert.equal(added, 1);
  assert.deepEqual(bt.childIds(bt.blockBody(map.root)), ['a', 'b']);
});

test('tableLayout: 直挂 body 的 cell_set', () => {
  const body = {
    type: 'table',
    rows_id: ['r1'],
    columns_id: ['c1', 'c2'],
    cell_set: { r1c1: { block_id: 'cell1' }, r1c2: { block_id: 'cell2' } }
  };
  const t = bt.tableLayout(body);
  assert.deepEqual(t.rows, ['r1']);
  assert.deepEqual(t.cols, ['c1', 'c2']);
  assert.equal(t.cellSet.r1c1.block_id, 'cell1');
});

test('tableLayout: 嵌套 data.table 字段', () => {
  const body = {
    type: 'table',
    table: {
      rows_id: ['r1'],
      columns_id: ['c1'],
      cell_set: { r1c1: { block_id: 'cellX' } }
    }
  };
  const t = bt.tableLayout(body);
  assert.equal(t.cellSet.r1c1.block_id, 'cellX');
});

test('missingSkipIds: 只返回 map 里还没有的 skip', () => {
  const skipped = new Set(['s1', 's2', 's3']);
  const map = { s1: { data: { type: 'table_cell' } } };
  assert.deepEqual(bt.missingSkipIds(skipped, map).sort(), ['s2', 's3']);
});

test('absorbSkipDiscovery: 新页带出的 skip_blocks 进入队列', () => {
  const skipped = new Set(['s1']);
  const map = {};
  bt.absorbPart(map, skipped, [], new Set(), {
    blockMap: { s1: { data: { type: 'table_cell', children: ['t1'] } } },
    skipBlocks: ['s2'],
    sequence: []
  });
  assert.ok(map.s1);
  assert.ok(skipped.has('s2'));
  assert.deepEqual(bt.missingSkipIds(skipped, map), ['s2']);
});

test('completenessIssues: 子树未拉完要报错', () => {
  const issues = bt.completenessIssues({
    pagingHitLimit: false,
    pagingStoppedEarly: false,
    skipRemaining: 12
  });
  assert.ok(issues.some(s => /子树|skip|表格/i.test(s)));
});

test('completenessIssues: 翻页撞上限要报错', () => {
  const issues = bt.completenessIssues({
    pagingHitLimit: true,
    pagingStoppedEarly: false,
    skipRemaining: 0
  });
  assert.ok(issues.some(s => /翻页|上限|截断/i.test(s)));
});

test('shouldPreferModel: 长文模型更完整 → 采用模型', () => {
  const ok = bt.shouldPreferModel(
    {
      plain: '字'.repeat(5000),
      images: 10,
      html: '<p>a</p>'.repeat(10),
      snapshot: { counts: { lines: 400 } }
    },
    { plain: '字'.repeat(800) },
    '<p>x</p>'
  );
  assert.equal(ok, true);
});

test('shouldPreferModel: 半残模型不盖页面（课表回归）', () => {
  const links = Array.from({ length: 15 }, (_, i) => '<a href="/w/' + i + '">c</a>').join('');
  const ok = bt.shouldPreferModel(
    {
      plain: '标题',
      images: 0,
      html: '<h1>t</h1>',
      snapshot: { counts: { lines: 1 } }
    },
    { plain: '课'.repeat(100) },
    links
  );
  assert.equal(ok, false);
});

test('shouldPreferModel: 字数与链接相当 → 可采用模型', () => {
  const links = Array.from({ length: 15 }, (_, i) => '<a href="/w/' + i + '">c</a>').join('');
  const ok = bt.shouldPreferModel(
    {
      plain: '课'.repeat(100),
      images: 0,
      html: links,
      snapshot: { counts: { lines: 15 } }
    },
    { plain: '课'.repeat(100) },
    links
  );
  assert.equal(ok, true);
});

test('tableCellTokensFromLayout: 列出所有单元格 block_id（供完整性核对）', () => {
  const t = bt.tableLayout({
    type: 'table',
    rows_id: ['r1'],
    columns_id: ['c1', 'c2'],
    cell_set: {
      r1c1: { block_id: 'cell1' },
      r1c2: { block_id: 'cell2' }
    }
  });
  assert.deepEqual(bt.tableCellTokens(t).sort(), ['cell1', 'cell2']);
});

test('missingTableCells: 单元格块不在 map → 计缺失', () => {
  const map = {
    tbl: {
      data: {
        type: 'table',
        rows_id: ['r1'],
        columns_id: ['c1'],
        cell_set: { r1c1: { block_id: 'missingCell' } }
      }
    }
  };
  const miss = bt.missingTableCellIds(map);
  assert.ok(miss.includes('missingCell'));
});

test('代码块多行 text：必须按行号 0/1/2 全读（回归丢字）', () => {
  // 模拟 content.js textFieldZones 修复后的行为
  function textFieldZones(textField) {
    const iat = textField.initialAttributedTexts || textField;
    let texts = iat.text || '';
    let attribs = iat.attribs || '';
    if (typeof texts === 'string') texts = { '0': texts };
    if (typeof attribs === 'string') attribs = { '0': attribs };
    const keys = Object.keys(texts).sort((a, b) => Number(a) - Number(b));
    return keys.map(k => texts[k] || '');
  }
  const multi = {
    initialAttributedTexts: {
      text: { '0': 'line0\n', '1': 'line1\n', '2': 'line2 keep' },
      attribs: { '0': '', '1': '', '2': '' }
    }
  };
  assert.equal(textFieldZones(multi).join(''), 'line0\nline1\nline2 keep');
});

test('代码块多 key 且无尾换行：必须分行不能拼成一行', () => {
  // 与 content.js linesFromTextField 对齐
  function textFieldZones(textField) {
    const iat = textField.initialAttributedTexts || textField;
    let texts = iat.text || '';
    if (typeof texts === 'string') texts = { '0': texts };
    const keys = Object.keys(texts).sort((a, b) => Number(a) - Number(b));
    return keys.map(k => ({ text: texts[k] || '' }));
  }
  function linesFromTextField(textField) {
    const zones = textFieldZones(textField);
    const lines = [];
    let cur = [];
    const pushLine = () => { lines.push(cur); cur = []; };
    zones.forEach((z, zi) => {
      const parts = String(z.text).split('\n');
      parts.forEach((part, i) => {
        if (part) cur.push(part);
        if (i < parts.length - 1) pushLine();
      });
      if (zones.length > 1 && zi < zones.length - 1) {
        if (cur.length) pushLine();
      }
    });
    if (cur.length || !lines.length) pushLine();
    return lines.map(l => l.join(''));
  }
  const multi = {
    initialAttributedTexts: {
      text: { '0': 'function a() {', '1': '  return 1;', '2': '}' }
    }
  };
  const lines = linesFromTextField(multi);
  assert.equal(lines.length, 3);
  assert.equal(lines.join('\n'), 'function a() {\n  return 1;\n}');
});

test('逐行逐字：缺一行必须判失败；合并段+破折号应通过', () => {
  const CHAR_RATIO_ABORT = 0.98;
  const CHAR_ABS_SLACK = 2;
  // 与 content.js charLineFidelity 对齐
  function charLineFidelity(srcPlain, destPlain) {
    const softNorm = (s) => String(s || '')
      .replace(/\r\n/g, '\n')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/\u00a0/g, ' ')
      .replace(/[—–―−﹣－]/g, '-')
      .replace(/＆/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
    const src = String(srcPlain || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    const dest = String(destPlain || '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    const srcLines = src.split('\n');
    const destHay = dest.split('\n').map(l => softNorm(l)).filter(Boolean);
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
      if (destFlat.includes(t)) return;
      const stripped = t.replace(/^[-]+/, '').trim();
      if (stripped.length >= 4 && destFlat.includes(stripped)) return;
      const compact = stripped.replace(/\s+/g, '');
      if (compact.length >= 4 && destFlat.replace(/\s+/g, '').includes(compact)) return;
      missingLines.push({ index: i + 1, text: raw.slice(0, 120) });
    });
    const srcN = softNorm(src).replace(/\s+/g, '').length;
    const destN = softNorm(dest).replace(/\s+/g, '').length;
    const ratio = srcN > 0 ? destN / srcN : 1;
    const charsOk = srcN <= destN + CHAR_ABS_SLACK || ratio >= CHAR_RATIO_ABORT;
    return { missingLines, ok: charsOk && missingLines.length === 0 };
  }
  const src = 'line-aaa\nline-bbb-unique-content\nline-ccc';
  const dest = 'line-aaa\nline-ccc';
  const bad = charLineFidelity(src, dest);
  assert.equal(bad.ok, false);
  assert.ok(bad.missingLines.length >= 1);
  assert.equal(charLineFidelity(src, src).ok, true);
  // 源分行、目标合并成一段且破折号形态不同 → 仍应通过
  const srcDash = '标题\n——飞书多维表格入门使用&案例拆解\n——Codex 安装及使用';
  const destMerged = '标题 ——飞书多维表格入门使用&案例拆解 ——Codex 安装及使用 额外说明字';
  assert.equal(charLineFidelity(srcDash, destMerged).ok, true);
  // HTML 实体 &amp; 与全角破折号
  assert.equal(charLineFidelity(
    '——飞书多维表格入门使用&案例拆解',
    '——飞书多维表格入门使用&amp;案例拆解'
  ).ok, true);
});

const dir = path.dirname(fileURLToPath(import.meta.url));
console.log('cwd-ish', dir);

if (failures.length) {
  console.error('\nFAILED', failures.length, 'case(s)');
  process.exit(1);
}
console.log('\nALL PASSED (' + passed + ' cases)');
process.exit(0);
