# FormSnap — AI 智能表单填写助手

> 截图即填，一键搞定重复表单。支持 Chrome / Edge 浏览器。

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-blue)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/React-18-61dafb)](https://react.dev/)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

FormSnap 是一个 AI 驱动的浏览器扩展，通过截图、文本或文件输入识别数据，自动匹配并填写到任意网页表单和在线表格中。独创**锚定逐行填写引擎**，无需硬编码任何网站选择器，通用于任意表单结构。

---

## 核心功能

| 功能 | 说明 |
|------|------|
| 截图识别 | 上传截图，多模态 AI 自动提取字段名和值 |
| 文本粘贴 | 粘贴任意格式文本，自动解析为结构化数据 |
| 三级匹配 | 精确匹配 → 模糊匹配 → AI 语义匹配，自动处理字段名差异 |
| **锚定逐行填写** | 用户点击第一个输入框锚定位置，Agent 自动逐行新增+填写+设开关 |
| **空行清理** | 填写完成后自动检测并删除多余空行 |
| Canvas 表格 | 自动识别 SpreadJS Canvas 表格，通过 AI 视觉 + 剪贴板粘贴突破限制 |
| 历史记录 | 每次填写自动保存，支持缩略图预览、编辑、复用 |
| **简历模板** | 内置快手校招简历模拟数据，一键载入测试 |
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

1. 打开 Chrome / Edge，访问 `chrome://extensions/`
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

### 场景一：普通表单填写

适用于简历、注册表、申请表等单页表单。

1. **输入数据** — 截图或粘贴文本
2. **确认数据** — 在 data-review 页面查看/编辑已识别字段
3. **扫描填写** — 点击「扫描页面并填写」，Agent 自动匹配并填写

### 场景二：逐行表格填写（Agent 模式）

适用于变量编辑器、配置面板等需要「+新增」按钮的重复行表格。

1. **输入数据** — 截图或粘贴多行表格数据
2. **确认数据** — 在 data-review 页面查看已识别的行列数据
3. **锚定填写** — 点击「锚定并逐行填写」
4. **点击锚定** — 在目标页面点击第一个输入框（如「名称」输入框）
5. **自动填写** — Agent 自动逐行：新增行 → 填名称 → 填描述 → 填默认值 → 设开关 → 循环
6. **清理空行** — 填完后自动删除多余空行

**锚定机制不依赖任何网站特定的 CSS 选择器**，完全通用。通过 Y 坐标定位同行元素，通过 Y 坐标递增定位新行。

### 场景三：Canvas 表格（坚果云等）

1. 扫描表单时会自动检测到 Canvas 表格
2. 自动截取页面并识别列名
3. 完成匹配后，点击「复制到剪贴板」
4. 在表格中 `Ctrl+V` 粘贴

---

## 技术架构

```
src/
├── background/     # Service Worker（消息路由、API 调用）
├── content/        # 内容脚本（表单扫描、表单填充、锚定引擎、Canvas 检测）
├── core/           # 核心逻辑（AI 引擎、类型定义）
├── popup/          # 弹出窗口 UI（React）
├── options/        # 设置/历史页面（React）
├── utils/          # 工具函数（存储、解析、图片处理）
└── public/         # 静态资源（manifest、图标、HTML 模板）
```

**技术栈**：TypeScript + React 18 + Webpack 5 + Chrome Extension Manifest V3

**AI 引擎**：支持任何 OpenAI 兼容 API，多模态模型用于截图识别，文本模型用于字段匹配。

### 锚定逐行填写引擎

```
用户点击输入框 → 记录锚定元素信息（tag/class/rect/selector）
    ↓
fillFromAnchor 循环：
    ↓
    Row 0: 直接填写已有空行
    Row 1-N: 点击「+新增」→ findElementBelowY 定位新行 → 填写
    ↓
    每行填写：findRowElements（Y 坐标匹配同行）→ 按列顺序填写
    ↓
    开关填写：视觉圆点位置判断状态 → 点击切换
    ↓
填完所有行 → cleanupEmptyRows 删除多余空行
```

---

## 安全

- 仅使用 `activeTab`、`scripting`、`storage` 三个最小权限
- 消息处理验证 `sender.id`，拒绝非自身扩展的消息
- API 端点 URL 格式校验，防止 SSRF
- React 默认 XSS 防护，无 `dangerouslySetInnerHTML`
- 无内容脚本静态注入，仅在用户触发时动态注入
- API Key 存储于 `chrome.storage.local`（Chrome 扩展标准做法）

---

## 开发

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（watch）
npm run build      # 生产构建
```

构建产物输出到 `dist/` 目录，可直接加载为 Chrome 扩展。

---

## License

MIT
