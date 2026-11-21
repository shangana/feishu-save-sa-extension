/**
 * 内容+样式：抽原子、找差、改正、再审。
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SF = require(path.join(root, 'core', 'style-fidelity.js'));

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

console.log('style-fidelity selftest');

test('抽 HTML：加粗/颜色/标题原子', () => {
  const html = '<h2>章节A</h2><p>普通 <strong>重点词</strong> 和 '
    + '<span style="color:#e11d48">红字</span></p>';
  const fp = SF.extractAtomsFromHtml(html);
  assert.ok(fp.structure.h2 >= 1);
  assert.ok(fp.atoms.some(a => a.text.includes('重点词') && a.bold));
  assert.ok(fp.atoms.some(a => a.text.includes('红字') && a.color));
  assert.ok(fp.atoms.some(a => a.text.includes('章节A') && a.block === 'h2'));
});

test('样式差：缺加粗必须检出', () => {
  const src = SF.atomsFromStyleSamples([{ text: '重点词', bold: true }]);
  const destHtml = '<p>重点词</p>';
  const dest = SF.extractAtomsFromHtml(destHtml).atoms;
  const miss = SF.diffStyleAtoms(src, dest, SF.normText(SF.stripTags(destHtml)));
  assert.ok(miss.length >= 1);
  assert.match(miss[0].issue, /加粗/);
});

test('自动改正：把裸文本补成加粗+颜色后应通过', () => {
  const srcHtml = '<p><strong><span style="color:#2563eb">蓝粗</span></strong></p>';
  const src = SF.extractAtomsFromHtml(srcHtml).atoms;
  const broken = '<p>蓝粗</p>';
  const result = SF.compareAndFix(src, SF.extractAtomsFromHtml(srcHtml).structure, broken);
  assert.ok(result.patched >= 1, '应至少改正 1 处');
  assert.equal(result.ok, true, '改正后应通过');
  assert.match(result.html, /strong/i);
  assert.match(result.html, /color/i);
});

test('标题级别丢失：p 提升为 h2', () => {
  const src = SF.atomsFromStyleSamples([{ text: '二级标题文案', block: 'h2' }]);
  const broken = '<p>二级标题文案</p>';
  const result = SF.compareAndFix(src, { h2: 1 }, broken);
  assert.equal(result.ok, true);
  assert.match(result.html, /<h2>二级标题文案<\/h2>/i);
});

test('标题级别：嵌套 p/strong 与错误 h1 均可改正为一句话总结 h2', () => {
  const src = SF.atomsFromStyleSamples([{ text: '一句话总结', block: 'h2' }]);
  const nested = SF.compareAndFix(src, { h2: 1 }, '<p><strong>一句话总结</strong></p>');
  assert.ok(nested.patched >= 1);
  assert.equal(nested.ok, true);
  assert.match(nested.html, /<h2>[\s\S]*一句话总结[\s\S]*<\/h2>/i);
  const retag = SF.compareAndFix(src, { h2: 1 }, '<h1>一句话总结</h1>');
  assert.ok(retag.patched >= 1);
  assert.equal(retag.ok, true);
  assert.match(retag.html, /<h2[^>]*>一句话总结<\/h2>/i);
});

test('改正失败：源有样式文本目标完全没有 → 不 ok', () => {
  const src = SF.atomsFromStyleSamples([{ text: '此句只在源文档', bold: true, color: '220,38,38' }]);
  const result = SF.compareAndFix(src, {}, '<p>完全另一篇</p>');
  assert.equal(result.ok, false);
  assert.ok(result.missing.length >= 1);
});

test('结构：代码块数量下降要告警', () => {
  const warns = SF.diffStructure({ pre: 3, h1: 1 }, { pre: 1, h1: 1 });
  assert.ok(warns.some(w => /pre/.test(w)));
});

if (failures.length) {
  console.error('\nFAILED', failures.length, 'case(s)');
  process.exit(1);
}
console.log('\nALL PASSED (' + passed + ' cases)');
process.exit(0);
