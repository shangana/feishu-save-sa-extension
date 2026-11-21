/**
 * 接线与回归冒烟：确认 content / manifest 已接上 core，且旧的 80 上限已去掉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

console.log('content-wire selftest');

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const content = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
const core = fs.readFileSync(path.join(root, 'core', 'block-tree.js'), 'utf8');

test('manifest 版本 2.28.7', () => {
  assert.equal(manifest.version, '2.28.7');
});

test('manifest 先加载 core 再 content.js', () => {
  const js = manifest.content_scripts[0].js;
  assert.ok(js.includes('core/block-tree.js'));
  assert.ok(js.includes('core/style-fidelity.js'));
  assert.ok(js.includes('core/html-normalize.js'));
  assert.ok(js.includes('content.js'));
  assert.ok(js.indexOf('core/block-tree.js') < js.indexOf('content.js'));
  assert.ok(js.indexOf('core/style-fidelity.js') < js.indexOf('content.js'));
  assert.ok(js.indexOf('core/html-normalize.js') < js.indexOf('content.js'));
});

test('content 版本号与 EXT_VERSION 一致', () => {
  assert.match(content, /EXT_VERSION = '2\.28\.7'/);
});

test('面向用户文案不含第三方品牌名', () => {
  assert.doesNotMatch(content, /游侠/);
  assert.doesNotMatch(content, /Youxia/i);
  assert.doesNotMatch(manifest.description || '', /游侠/);
});

test('逐行核对支持合并段/破折号/实体；样式差不硬中止', () => {
  assert.match(content, /destFlat\.includes/);
  assert.match(content, /[—–―−﹣－]/);
  assert.match(content, /&amp;/);
  assert.match(content, /仅模型路径用模型样式指纹/);
  assert.match(content, /样式仍有差异（已尽量修正，继续提交）/);
  assert.doesNotMatch(content, /内容\+样式比对失败：仍有/);
});

test('标题优先知识库节点名；PDF/附件上传并保留链接', () => {
  assert.match(content, /function resolveTransferTitle/);
  assert.match(content, /function syncLeadingH1/);
  assert.match(content, /fetchWikiNode/);
  assert.match(content, /把附件存入你的云空间/);
  assert.match(content, /isPdf \? 'PDF'/);
  assert.match(content, /absolutizeHref/);
  assert.match(content, /已保留源文件链接/);
});

test('2.28.4+：drive-stream 链改写 + 红标题色 + 字母数字 media id', () => {
  assert.match(content, /FxferHtmlNormalize/);
  assert.match(content, /normalizeHtmlLinksInPlace/);
  assert.match(content, /salvageDomLinksIntoHtml/);
  assert.match(content, /listMediaPlaceholderIds/);
  assert.match(content, /resolveInlineColors/);
  assert.match(content, /colorFromClassName/);
  assert.match(content, /wrapColoredHtml/);
  assert.match(content, /a\.link, a\[data-href\], a\[href\]/);
  assert.match(content, /[A-Za-z0-9_-]+/);
});

test('2.28.6：代码块保留 textHighlight 字色', () => {
  assert.match(content, /extractCodeColoredLines/);
  assert.match(content, /renderCodeHtmlFromBody/);
  assert.match(content, /buildColoredCodeHtml/);
  assert.match(content, /codeSpanDocColor/);
  assert.match(content, /只认文档标注色/);
  assert.match(content, /不要用无色模型盖掉红字/);
});

test('成功面板不再展示对比报告', () => {
  assert.doesNotMatch(content, /复制对比报告/);
  assert.doesNotMatch(content, /正在自动对比新文档/);
  assert.match(content, /ui\.result\(`新文档：/);
});

test('禁止复制时走精细重建（结果导向）', () => {
  assert.match(content, /切换精细重建/);
  assert.match(content, /parse_html/);
  assert.match(content, /explorer\/v2\/clone\//);
  assert.match(content, /精细重建（源文档禁止创建副本）/);
  assert.match(content, /同步完成/);
  assert.match(content, /扫描正文/);
  assert.match(content, /复核扫读/);
  assert.doesNotMatch(content, /采集正文（第/);
  assert.doesNotMatch(content, /补漏（第/);
});

test('主路径为 explorer/v2/clone 云盘复制', () => {
  assert.match(content, /explorer\/v2\/clone\//);
  assert.match(content, /tryDriveObjectCopy/);
  assert.match(content, /pickCloneDriveUrl/);
  assert.match(content, /feishuPostForm/);
  assert.match(content, /scene:\s*'space_copy'/);
  assert.match(content, /自动同步到飞书云盘/);
  assert.doesNotMatch(content, /box\/file\/multi_copy\//);
});

test('云盘目标支持 root_folder/meta 与 folder_token=0 回退', () => {
  assert.match(content, /root_folder\/meta/);
  assert.match(content, /folder_token=0/);
  assert.match(content, /ensureWritableDriveFolder/);
});

test('不再把源 wiki 当作默认写入目标', () => {
  assert.doesNotMatch(content, /src-parent/);
  assert.doesNotMatch(content, /src-self-as-parent/);
  assert.match(content, /collectWritableWikiTargets/);
  assert.match(content, /getMySpaceRootToken/);
});

test('已废弃实测 404 的 box/service/copy/ 作为主候选', () => {
  assert.doesNotMatch(content, /\/space\/api\/box\/service\/copy\/'/);
});

test('copy_by_obj ext_info 使用字符串 false/true（防 InvalidParam）', () => {
  assert.match(content, /only_schema:\s*'false'/);
  assert.match(content, /only_base_app:\s*'true'/);
  assert.doesNotMatch(content, /only_schema:\s*false\s*,/);
});

test('代码块 textFieldZones 不再只读 key 0', () => {
  assert.doesNotMatch(content, /hasOwnProperty\.call\(texts, '0'\) \? \['0'\]/);
  assert.match(content, /Object\.keys\(texts\)\.sort/);
});

test('多 key 无尾换行会 pushLine；空段落保留；逐字门禁存在', () => {
  assert.match(content, /zones\.length > 1 && zi < zones\.length - 1/);
  assert.match(content, /<p><br><\/p>/);
  assert.match(content, /function charLineFidelity/);
  assert.match(content, /逐行逐字校验/);
  assert.match(content, /plainFromCodeBody/);
  assert.match(content, /mergeLongerCodesIntoHtml/);
  assert.doesNotMatch(content, /const deduped = lines\.filter/);
});

test('content 委托 BT 做 skip / 根序 / 完整性', () => {
  assert.match(content, /BT\.missingSkipIds/);
  assert.match(content, /BT\.patchRootChildren/);
  assert.match(content, /BT\.completenessIssues/);
  assert.match(content, /BT\.shouldPreferModel/);
  assert.match(content, /BT\.tableLayout/);
});

test('已去掉 skip_blocks 串行 80 上限', () => {
  assert.doesNotMatch(content, /skipIds\.length && i < 80/);
  assert.match(content, /SKIP_FETCH_MAX_REQUESTS/);
  assert.match(content, /SKIP_FETCH_CONCURRENCY/);
});

test('采用不完整模型时会停止', () => {
  assert.match(content, /全量文档数据不完整，已停止/);
});

test('core 导出关键 API', () => {
  assert.match(core, /patchRootChildren/);
  assert.match(core, /missingTableCellIds/);
  assert.match(core, /completenessIssues/);
  assert.match(core, /shouldPreferModel/);
});

if (failures.length) {
  console.error('\nFAILED', failures.length, 'case(s)');
  process.exit(1);
}
console.log('\nALL PASSED (' + passed + ' cases)');
process.exit(0);
