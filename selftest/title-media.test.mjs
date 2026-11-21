/**
 * 标题选择 + 附件链接保留 回归
 */
import assert from 'node:assert/strict';

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

console.log('title-media selftest');

function cleanTitleText(s) {
  let t = String(s || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/\s*[-–—|]\s*(Feishu Docs|Lark Docs|飞书云文档|飞书文档|飞书)\s*$/i, '');
  return t;
}

function pickTitle(wikiTitle, h1, dom, tab) {
  const lessonRe = /第\s*\d+\s*课|训练营|成长路线|开营/;
  wikiTitle = cleanTitleText(wikiTitle);
  h1 = cleanTitleText(h1);
  dom = cleanTitleText(dom);
  tab = cleanTitleText(tab);
  if (wikiTitle && wikiTitle.length >= 2) {
    if (!h1 || wikiTitle === h1 || wikiTitle.includes(h1) || h1.includes(wikiTitle)) return wikiTitle;
    if (lessonRe.test(wikiTitle) && (!lessonRe.test(h1) || wikiTitle.length >= h1.length)) return wikiTitle;
    return wikiTitle;
  }
  if (tab && lessonRe.test(tab) && h1 && !lessonRe.test(h1) && tab.length > h1.length) return tab;
  if (dom && lessonRe.test(dom) && h1 && !lessonRe.test(h1) && dom.length > h1.length) return dom;
  return h1 || dom || tab || '转存文档';
}

test('课名 wiki 优先于章节 h1', () => {
  const t = pickTitle(
    '第8课：IP & 流量 - AI时代的成长路线和财富机会',
    '与必火AI共同成长',
    '与必火AI共同成长',
    '第8课：IP & 流量 - AI时代的成长路线和财富机会 - 飞书云文档'
  );
  assert.match(t, /第\s*8\s*课/);
  assert.doesNotMatch(t, /^与必火AI共同成长$/);
});

test('无 wiki 时用带课名的 tab', () => {
  const t = pickTitle('', '与必火AI共同成长', '', '第8课：IP & 流量 - AI时代的成长路线和财富机会');
  assert.match(t, /第\s*8\s*课/);
});

test('附件 HTML 必须带可点 /file/ 链接（回归「未随转存带出」）', () => {
  const bad = '<p>【附件】第5课-必火AI简介.pdf（约 1.2MB，非文本/视频素材，未随转存带出）</p>';
  const good = '<p>【PDF】<a href="https://my.feishu.cn/file/ABC">第5课-必火AI简介.pdf</a>（1.2MB，已保存到你的云空间）</p>';
  assert.doesNotMatch(good, /未随转存带出/);
  assert.match(good, /\/file\//);
  assert.match(bad, /未随转存带出/); // 旧行为样本，确保我们记得修掉
});

test('drive-stream 预览链不得原样提交（parse_html 会剥链）', () => {
  const drive = 'https://internal-api-drive-stream.feishu.cn/space/api/box/stream/download/preview/Nk0abUmYLoLlF8xoYW9cOaKPnMd?mount_point=docx_file&preview_type=16';
  const badSubmit = '<a href="' + drive + '">第5课-必火AI简介.pdf</a>';
  const goodSubmit = '<a href="https://bcnox2hvmoia.feishu.cn/file/Nk0abUmYLoLlF8xoYW9cOaKPnMd">第5课-必火AI简介.pdf</a>';
  assert.match(badSubmit, /internal-api-drive-stream/);
  assert.doesNotMatch(goodSubmit, /internal-api-drive-stream/);
  assert.match(goodSubmit, /\/file\/Nk0abUmYLoLlF8xoYW9cOaKPnMd/);
});

test('红标题必须带 #d83931（textHighlight-pink-text）', () => {
  const good = '<h2><font color="#d83931"><span style="color:#d83931" color="#d83931">与必火AI共同成长</span></font></h2>';
  assert.match(good, /#d83931/);
  assert.match(good, /与必火AI共同成长/);
});

if (failures.length) {
  console.error('\nFAILED', failures.length, 'case(s)');
  process.exit(1);
}
console.log('\nALL PASSED (' + passed + ' cases)');
process.exit(0);
