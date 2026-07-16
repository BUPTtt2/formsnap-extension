# FormSnap — AI 智能表单填写助手

> 截图即填，一键搞定重复表单。支持 Chrome / Edge 浏览器。

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

FormSnap 是一个 AI 驱动的浏览器扩展，通过截图、文本或文件输入识别数据，自动匹配并填写到任意网页表单和在线表格中。特别针对坚果云等使用 SpreadJS Canvas 渲染的在线表格做了深度适配。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 截图识别 | 上传截图，多模态 AI 自动提取字段名和值 |
| 文本粘贴 | 粘贴任意格式文本，自动解析为结构化数据 |
| 文件导入 | 支持 Excel/CSV 文件批量导入 |
| 三级匹配 | 精确匹配 → 模糊匹配 → AI 语义匹配，自动处理字段名差异 |
| Canvas 表格 | 自动识别 SpreadJS Canvas 表格，通过 AI 视觉 + 剪贴板粘贴突破限制 |
| 多行数据 | 多张截图独立解析，TSV 格式一键粘贴多行 |
| 历史记录 | 每次填写自动保存，支持编辑、添加、删除、复用 |
| 撤销功能 | 填写后可一键撤销，恢复原始数据 |

---

## 安装

### 从源码安装（开发模式）

```bash
git clone https://github.com/BUPTtt2/formsnap-extension.git
cd formsnap-extension
npm install
npm run build
```

1. 打开 Chrome，访问 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择 `dist/` 目录

### 配置 API

1. 点击扩展图标 → 设置（齿轮图标）
2. 选择预设 AI 提供商，或自定义 API 端点
3. 填入 API Key

支持的 AI 提供商：
- OpenAI GPT-4o
- 智谱 GLM-4-Flash（免费）
- 硅基流动 SiliconFlow
- DeepSeek
- 阿里云百炼（通义千问）
- 自定义 OpenAI 兼容 API

---

## 使用方式

### 基本流程

1. **输入数据** — 截图、粘贴文本或上传文件
2. **确认匹配** — AI 自动匹配数据源字段与表单字段，拖拽调整
3. **一键填写** — 点击填充，自动填写所有字段

### Canvas 表格（坚果云等）

1. 扫描表单时会自动检测到 Canvas 表格
2. 自动截取页面并识别列名
3. 完成匹配后，点击「复制到剪贴板」
4. 在表格中 `Ctrl+V` 粘贴

---

## 技术架构

```
src/
├── background/     # Service Worker（消息路由、API 调用）
├── content/        # 内容脚本（表单扫描、表单填充、Canvas 检测）
├── core/           # 核心逻辑（AI 引擎、类型定义）
├── popup/          # 弹出窗口 UI（React）
├── options/        # 设置/历史页面（React）
├── utils/          # 工具函数（存储、解析、图片处理）
└── public/         # 静态资源（manifest、图标、HTML 模板）
```

**技术栈**：TypeScript + React 18 + Webpack 5 + Chrome Extension Manifest V3

**AI 引擎**：支持任何 OpenAI 兼容 API，多模态模型用于截图识别，文本模型用于字段匹配。

---

## 安全

- 仅使用 `activeTab`、`scripting`、`storage` 三个最小权限
- 消息处理验证 `sender.id`，拒绝非自身扩展的消息
- API 端点 URL 格式校验，防止 SSRF
- React 默认 XSS 防护，无 `dangerouslySetInnerHTML`
- 无内容脚本静态注入，仅在用户触发时动态注入
- API Key 存储于 `chrome.storage.local`（Chrome 扩展标准做法）

详见 [docs/04-安全审查.md](docs/04-安全审查.md)

---

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（watch）
npm run build      # 生产构建
```

构建产物输出到 `dist/` 目录，可直接加载为 Chrome 扩展。

---

## Demo 展示

在线交互演示：[FormSnap Demo](https://BUPTtt2.github.io/formsnap-demo)

---

## License

MIT