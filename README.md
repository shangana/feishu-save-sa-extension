# 飞书文档转存（Chrome 扩展）

把飞书文档转存到自己的飞书空间。目标：**转存后的内容、样式与原文一致**（含禁止划词/创建副本的文档）。

零配置：不需要创建飞书应用，不需要填 App ID / Secret，直接用当前浏览器已登录的飞书身份。

Author / Copyright: **sa**（MIT License）


## 安装

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车
2. 打开右上角「**开发者模式**」
3. 点「**加载已解压的扩展程序**」，选择本目录
4. 打开任意飞书文档，右下角会出现「** 转存此文档**」

## 使用

1. 打开要转存的飞书文档（能看到内容即可）
2. 点右下角按钮，选择「我的空间」目标文件夹
3. 等进度走完（长文档 + 多图会需要几分钟；**不要切走该标签页**）
4. 完成后面板给出新文档链接

## 工作原理

1. **优先原生复制**（`explorer/v2/clone`）——服务端对象复制  
2. **禁止创建副本时自动高保真重建**——拉全量 `client_vars` / 页面采集，保留标题、正文、链接、加粗/颜色/代码块等，再写入云盘  
3. 上传前做字数/链接/代码块硬门禁；样式尽量自动改正，改不完告警仍上传（避免误杀）

## 已知限制

- 只支持飞书云文档（`/wiki/`、`/docx/`）
- 画板 / 多维表实况 / 同步块等私有块可能降级为预览或占位
- 水印、权限条等 UI 不会带进新文档（正文内容与样式对齐）
- 转存过程中不要切走标签页

## 目录说明

| 路径 | 说明 |
|------|------|
| `manifest.json` / `background.js` / `content.js` / `content.css` | 扩展本体 |
| `core/` | 块树、样式保真、HTML 规范化 |
| `icons/` | 扩展图标 |
| `selftest/` | Node 回归自测（不随扩展注入页面） |
| `docs/` | 协作与交付约定（可选阅读） |

## 自测

在仓库根目录执行：

```bash
node selftest/block-tree.test.mjs
node selftest/content-wire.test.mjs
node selftest/html-normalize.test.mjs
node selftest/style-fidelity.test.mjs
node selftest/title-media.test.mjs
```
