/**
 * 强制回归：标题红字 + drive-stream PDF 链（对照课文档真实 DOM）
 * 不过这些用例禁止交付。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const HN = require(path.join(root, 'core', 'html-normalize.js'));

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

console.log('html-normalize selftest');

const ORIGIN = 'https://bcnox2hvmoia.feishu.cn';
const DRIVE = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/Nk0abUmYLoLlF8xoYW9cOaKPnMd?mount_point=docx_file&preview_type=16';
const PDF_NAME = '第5课-必火AI简介.pdf';

test('drive-stream 预览链抽出 file token', () => {
  assert.equal(HN.driveTokenFromHref(DRIVE), 'Nk0abUmYLoLlF8xoYW9cOaKPnMd');
});

test('normalizeHrefForParse：drive-stream → 同源 /file/token（parse_html 可保留）', () => {
  const n = HN.normalizeHrefForParse(DRIVE, ORIGIN);
  assert.equal(n, ORIGIN + '/file/Nk0abUmYLoLlF8xoYW9cOaKPnMd');
  assert.doesNotMatch(n, /internal-api-drive-stream/);
  assert.doesNotMatch(n, /download\/preview/);
});

test('外链不被误伤', () => {
  const u = 'https://sinc9.xetslk.com/sl/2YWVVA';
  assert.equal(HN.normalizeHrefForParse(u, ORIGIN), u);
});

test('HTML 内多处 PDF 预览链批量改写为 /file/', () => {
  const html = [
    '<p>完整PPT</p>',
    '<p><a class="link" href="' + DRIVE + '">第6期：第5课-AI时代的成长路线和财富机会.pdf</a></p>',
    '<p><a href="https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/ABCDabcdABCDabcdABCD12xy?mount_point=docx_file&preview_type=16">' + PDF_NAME + '</a></p>',
    '<p><a href="https://sinc9.xetslk.com/sl/2YWVVA">https://sinc9.xetslk.com/sl/2YWVVA</a></p>'
  ].join('');
  const out = HN.normalizeHtmlLinks(html, ORIGIN);
  assert.match(out, /\/file\/Nk0abUmYLoLlF8xoYW9cOaKPnMd/);
  assert.match(out, /\/file\/ABCDabcdABCDabcdABCD12xy/);
  assert.match(out, /sinc9\.xetslk\.com/);
  assert.doesNotMatch(out, /internal-api-drive-stream/);
  assert.equal(HN.countFileLikeLinks(out) >= 2, true);
});

test('textHighlight red/pink 映射为字色 #d83931，不是底色', () => {
  const r = HN.resolveInlineColors({ textHighlight: 'red' });
  assert.equal(r.color, '#d83931');
  assert.equal(r.bg, '');
  const p = HN.resolveInlineColors({ textHighlight: 'pink' });
  assert.equal(p.color, '#d83931');
  const pt = HN.resolveInlineColors({ textHighlight: 'pink-text' });
  assert.equal(pt.color, '#d83931');
});

test('light_* textHighlight 才是底色', () => {
  const r = HN.resolveInlineColors({ textHighlight: 'light_yellow' });
  assert.equal(r.color, '');
  assert.equal(r.bg, '#fef2c4');
});

test('class textHighlight-pink-text / doc-textcolor-red → #d83931', () => {
  assert.equal(
    HN.colorFromClassName('textHighlight textHighlight-pink-text textHighlight-ccmtoken-doc-textcolor-red'),
    '#d83931'
  );
});

test('标题 HTML 包上 font+span color，便于 parse_html 保留红字', () => {
  const inner = '与必火AI共同成长';
  const wrapped = HN.wrapColoredHtml(inner, '#d83931');
  assert.match(wrapped, /font color="#d83931"/);
  assert.match(wrapped, /style="color:#d83931"/);
  assert.match(wrapped, /与必火AI共同成长/);
});

test('字母数字 media 占位 id 能列出并替换（回归只认 \\d+ 的 bug）', () => {
  const html = '<p>前</p><div data-fxfer-media="doxcnLFkGmJTX73lAe3ef6aTOUe"></div><p>后</p>'
    + '<div data-fxfer-media="42"></div>';
  const ids = HN.listMediaPlaceholderIds(html);
  assert.ok(ids.includes('doxcnLFkGmJTX73lAe3ef6aTOUe'));
  assert.ok(ids.includes('42'));
  const out = HN.replaceMediaPlaceholder(
    html,
    'doxcnLFkGmJTX73lAe3ef6aTOUe',
    '<p>【PDF】<a href="' + ORIGIN + '/file/TOK">' + PDF_NAME + '</a></p>'
  );
  assert.doesNotMatch(out, /data-fxfer-media="doxcn/);
  assert.match(out, /\/file\/TOK/);
  assert.match(out, /必火AI简介\.pdf/);
});

test('未规范化的 drive-stream 样本必须被判定为「会丢链」', () => {
  const bad = '<p><a href="' + DRIVE + '">' + PDF_NAME + '</a></p>';
  assert.match(bad, /internal-api-drive-stream/);
  const good = HN.normalizeHtmlLinks(bad, ORIGIN);
  assert.doesNotMatch(good, /internal-api-drive-stream/);
  assert.match(good, /\/file\/Nk0abUmYLoLlF8xoYW9cOaKPnMd/);
});

test('代码块按行保留红字（结构化提问回归）', () => {
  const lines = [
    { parts: [{ text: '我需要一篇关于时间管理的文章', color: '' }] },
    { parts: [{ text: '- 目标读者：职场新人', color: '#d83931' }] },
    { parts: [{ text: '- 文章长度：1500字左右', color: '#d83931' }] },
    { parts: [{ text: '- 写作风格：轻松口语化，像朋友聊天', color: '#d83931' }] },
    { parts: [{ text: '- 核心要点：介绍3个实用的时间管理方法', color: '#d83931' }] },
    { parts: [{ text: '- 要求：每个方法都要有具体案例', color: '#d83931' }] }
  ];
  const html = HN.buildColoredCodeHtml(lines, '');
  assert.match(html, /<pre[\s\S]*<code/);
  assert.match(html, /我需要一篇关于时间管理的文章/);
  assert.match(html, /font color="#d83931"[\s\S]*目标读者：职场新人/);
  assert.match(html, /font color="#d83931"[\s\S]*每个方法都要有具体案例/);
  const bad = '<pre><code>我需要一篇关于时间管理的文章\n- 目标读者：职场新人</code></pre>';
  assert.doesNotMatch(bad, /#d83931/);
});

test('wrapCodeSegment 无色不包标签；有色双写 font+span', () => {
  assert.equal(HN.wrapCodeSegment('abc', ''), 'abc');
  assert.match(HN.wrapCodeSegment('- 目标读者', '#d83931'), /font color="#d83931"/);
  assert.match(HN.wrapCodeSegment('<script>', '#d83931'), /&lt;script&gt;/);
});

if (failures.length) {
  console.error('\nFAILED', failures.length, 'case(s)');
  process.exit(1);
}
console.log('\nALL PASSED (' + passed + ' cases)');
process.exit(0);
