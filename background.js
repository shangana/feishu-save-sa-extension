/* 飞书文档转存 - 后台脚本
 * 转存完成后：把视频下载到本地 → 打开新文档 → 用 Chrome 调试协议(CDP)发"可信"鼠标/拖拽事件，
 * 让视频落在文档里原来的位置（合成事件做不到可靠落点，必须用 CDP）。
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function waitComplete(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; chrome.tabs.onUpdated.removeListener(onUpd); resolve(); };
    const onUpd = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(onUpd);
    chrome.tabs.get(tabId, (t) => { if (t && t.status === 'complete') finish(); });
    setTimeout(finish, 20000);
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (resp) => { void chrome.runtime.lastError; resolve(resp); });
  });
}

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (r) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message)); else resolve(r);
    });
  });
}

async function downloadToDisk(url, name) {
  const id = await chrome.downloads.download({ url, filename: 'fxfer/' + name, conflictAction: 'overwrite' });
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    const [it] = await chrome.downloads.search({ id });
    if (!it) throw new Error('下载记录丢失');
    if (it.state === 'complete') return it.filename;
    if (it.state === 'interrupted') throw new Error('下载中断：' + (it.error || ''));
  }
  throw new Error('下载超时');
}

async function runInsert(docUrl, items, sendResponse) {
  try {
    const origin = docUrl.replace(/^(https?:\/\/[^/]+).*$/, '$1');
    const tab = await chrome.tabs.create({ url: docUrl, active: true });
    await waitComplete(tab.id);
    await sleep(3000);

    const files = [];
    for (const it of items) {
      const url = origin + '/space/api/box/stream/download/all/' + it.fileToken;
      const p = await downloadToDisk(url, (it.name || 'video') + '.mp4');
      files.push({ path: p, name: it.name || 'video' });
    }

    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    try {
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        // 每个视频各自定位它自己的【视频】占位（按第 i 个），落到原位
        let loc = null;
        for (let a = 0; a < 3 && !(loc && loc.found); a++) {
          loc = await sendToTab(tab.id, { type: 'fxfer-locate', index: i });
          if (!(loc && loc.found)) await sleep(2000);
        }
        const x = Math.round((loc && loc.x) || 480);
        const y = Math.round((loc && loc.y) || 300);
        await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        await sleep(150);
        await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(700);
        const data = {
          items: [{ mimeType: 'application/octet-stream', data: '', title: f.name }],
          files: [f.path],
          dragOperationsMask: 1
        };
        await cdp(tab.id, 'Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
        await sleep(350);
        await cdp(tab.id, 'Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
        await sleep(350);
        await cdp(tab.id, 'Input.dispatchDragEvent', { type: 'drop', x, y, data });
        await sleep(5000);
      }
    } finally {
      try { await chrome.debugger.detach({ tabId: tab.id }); } catch (e) { }
    }
    sendToTab(tab.id, { type: 'fxfer-inserted', count: files.length });
    sendResponse({ ok: true, tabId: tab.id });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  }
}

function needlesHitBg(item, hay) {
  const needles = item.needle || [];
  if (!needles.length) {
    const p = (item.preview || '').slice(0, 16);
    return !p || hay.indexOf(p) >= 0;
  }
  let hit = 0;
  for (const n of needles) {
    if (n && hay.indexOf(n) >= 0) hit++;
  }
  return hit >= Math.ceil(needles.length / 2);
}

function inventoryNeedlesHit(inventory, destInv) {
  const src = inventory || {};
  const dest = destInv || {};
  const plain = dest.plain || '';
  const codeHay = ((dest.codes || []).map((c) => ((c.preview || '') + '\n' + (c.needle || []).join('\n'))).join('\n'));
  const hay = plain + '\n' + codeHay;
  const missing = [];
  const checkList = []
    .concat(src.codes || [])
    .concat(src.headings || [])
    .concat((src.texts || []).filter((t) => (t.preview || '').length >= 12));
  for (const item of checkList) {
    if (!needlesHitBg(item, hay)) {
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

async function runAuditDest(docUrl, inventory, sendResponse) {
  let tabId = null;
  try {
    const tab = await chrome.tabs.create({ url: docUrl, active: false });
    tabId = tab.id;
    await waitComplete(tabId);
    await sleep(3200);
    let dest = null;
    for (let a = 0; a < 4 && !(dest && dest.ok); a++) {
      dest = await sendToTab(tabId, { type: 'fxfer-audit-scan' });
      if (!(dest && dest.ok)) await sleep(1800);
    }
    if (!(dest && dest.ok)) {
      sendResponse({ ok: false, error: (dest && dest.error) || '无法读取新文档' });
      return;
    }
    const report = inventoryNeedlesHit(inventory || {}, dest.inventory || {});
    // 把目标全文快照回传给源页，由 content.js 做结构化 diff
    sendResponse({
      ok: true,
      report,
      snapshot: dest.snapshot || null
    });
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
  } finally {
    if (tabId != null) {
      try { chrome.tabs.remove(tabId); } catch (e) { }
    }
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  if (msg.type === 'fxfer-open-and-insert') { runInsert(msg.docUrl, msg.items || [], sendResponse); return true; }
  if (msg.type === 'fxfer-audit-dest') {
    runAuditDest(msg.docUrl, msg.inventory || {}, sendResponse);
    return true;
  }
});
