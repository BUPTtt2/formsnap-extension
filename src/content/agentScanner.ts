// ---------------------------------------------------------------------------
// Agent 扫描引擎 —— 表格型弹窗扫描、填写、新增行、页面模式检测
// 供 formScanner.ts 调用，仅使用原生 DOM API，无外部依赖
// ---------------------------------------------------------------------------

// ========================== 类型定义 ==========================

/** 表格弹窗行中每个单元格的输入元素信息 */
export interface TableModalCell {
  colIndex: number;
  headerName: string; // 列头名称
  element: HTMLElement;
  type: 'input' | 'textarea' | 'contenteditable' | 'select' | 'toggle';
  selector: string;
}

/** 表格弹窗中的一行 */
export interface TableModalRow {
  rowIndex: number;
  cells: TableModalCell[];
}

/** 表格弹窗扫描结果 */
export interface TableModalInfo {
  detected: boolean;
  rows: TableModalRow[];
  headers: string[];
  modalSelector: string;
}

/** 映射项：源字段 → 目标列头 */
export interface TableMapping {
  sourceField: string;
  sourceValue: string;
  targetHeaderName: string;
}

/** 页面模式类型 */
export type PageMode =
  | 'standard-form'
  | 'table-modal'
  | 'canvas-spreadsheet'
  | 'settings-panel'
  | 'unknown';

/** 页面模式检测结果 */
export interface PageModeResult {
  mode: PageMode;
  confidence: number;
  reason: string;
}

// ========================== 工具函数 ==========================

/** Promise 化的 setTimeout 延迟 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 为元素生成可靠的 CSS 选择器（nth-child 回退策略）
 */
function buildSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur && cur !== document.body && cur !== document.documentElement) {
    let seg = cur.tagName.toLowerCase();
    if (cur.id) {
      seg = `#${CSS.escape(cur.id)}`;
      parts.unshift(seg);
      break;
    }
    const parent: HTMLElement | null = cur.parentElement;
    if (parent) {
      const idx = Array.from(parent.children).indexOf(cur) + 1;
      seg += `:nth-child(${idx})`;
    }
    parts.unshift(seg);
    cur = parent;
  }
  return parts.join(' > ');
}

/**
 * 判断元素是否在视口中可见
 */
function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  return true;
}

/**
 * React 受控组件安全赋值：通过原生 setter 触发 React 内部更新，
 * 同时派发 input / change 事件确保 onChange 回调执行。
 */
function setNativeValue(element: HTMLElement, value: string): void {
  const valueSetter =
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set ||
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  if (valueSetter) {
    valueSetter.call(element, value);
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
}

// ========================== 1. 表格型弹窗扫描 ==========================

/**
 * 查找页面上所有可见的弹窗容器。
 * 匹配策略：role="dialog"、.modal、.ant-modal、.el-dialog，
 * 以及 position:fixed 的遮罩层（.ant-modal-mask 等）内第一个可见子元素。
 */
function findVisibleModals(): HTMLElement[] {
  const selectors = [
    '[role="dialog"]',
    '.modal',
    '.ant-modal',
    '.el-dialog',
    '[aria-modal="true"]',
    '[class*="Modal"]',
    '[class*="modal"]',
    '[class*="Drawer"]',
    '[class*="drawer"]',
  ];
  const modals: HTMLElement[] = [];
  for (const sel of selectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      nodes.forEach((node) => {
        const el = node as HTMLElement;
        if (isVisible(el) && !modals.includes(el)) {
          modals.push(el);
        }
      });
    } catch {
      // 无效选择器，跳过
    }
  }

  // 额外查找 position:fixed 遮罩层内第一个可见子容器
  try {
    const overlays = document.querySelectorAll(
      '[class*="mask"], [class*="overlay"], [class*="Mask"], [class*="Overlay"]'
    );
    Array.from(overlays).forEach((overlay) => {
      const style = window.getComputedStyle(overlay);
      if (style.position !== 'fixed') return;
      for (const child of Array.from(overlay.children)) {
        const el = child as HTMLElement;
        if (isVisible(el) && !modals.includes(el)) {
          modals.push(el);
          break; // 只取第一个可见子元素
        }
      }
    });
  } catch {
    // 忽略
  }

  return modals;
}

/**
 * 在容器内查找真正的表格结构（<table> 或 div 模拟表格）。
 * 返回表格的根元素和列头数组。
 */
function findTableStructure(container: HTMLElement): {
  tableRoot: HTMLElement | null;
  headers: string[];
} | null {
  // 策略 1：原生 <table>
  const nativeTable = container.querySelector('table');
  if (nativeTable) {
    const headers = extractHeadersFromNativeTable(nativeTable as HTMLTableElement);
    if (headers.length > 0) {
      return { tableRoot: nativeTable as HTMLElement, headers };
    }
  }

  // 策略 2：div 模拟表格 —— 查找具有网格布局的容器
  // 启发式：一个容器下有多个子元素（行），每行又有多个子元素（列），且首行文本较短（列头）
  const divGrid = findDivGridInContainer(container);
  if (divGrid) {
    return divGrid;
  }

  return null;
}

/**
 * 从原生 <table> 提取列头。
 * 优先取 <th> 行，其次取第一行 <td>。
 */
function extractHeadersFromNativeTable(table: HTMLTableElement): string[] {
  const thead = table.querySelector('thead');
  if (thead) {
    const ths = thead.querySelectorAll('th');
    return Array.from(ths)
      .map((th) => th.textContent?.trim() || '')
      .filter(Boolean);
  }
  // 没有 thead 时取第一行
  const firstRow = table.querySelector('tr');
  if (firstRow) {
    return Array.from(firstRow.children)
      .map((cell) => cell.textContent?.trim() || '')
      .filter(Boolean);
  }
  return [];
}

/**
 * 在容器内查找 div 模拟的表格（grid layout）。
 * 条件：至少 2 行，每行至少 2 列，首行文本较短（列头特征）。
 */
function findDivGridInContainer(container: HTMLElement): {
  tableRoot: HTMLElement | null;
  headers: string[];
} | null {
  // 查找常见网格容器 class
  const gridSelectors = [
    '.ant-table',
    '.el-table',
    '[class*="table-body"]',
    '[class*="tableBody"]',
    '[role="grid"]',
    '[role="table"]',
  ];
  for (const sel of gridSelectors) {
    try {
      const grid = container.querySelector(sel) as HTMLElement | null;
      if (grid && isVisible(grid)) {
        const result = analyzeDivGrid(grid);
        if (result) return result;
      }
    } catch {
      // 无效选择器
    }
  }

  // 通用启发式：遍历容器内直接子元素，看是否有网格特征
  for (const child of Array.from(container.children)) {
    const el = child as HTMLElement;
    const result = analyzeDivGrid(el);
    if (result) return result;
  }

  return null;
}

/**
 * 分析一个元素是否为 div 模拟的网格表格。
 * 通过检查子元素的行/列结构来判断。
 */
function analyzeDivGrid(root: HTMLElement): {
  tableRoot: HTMLElement;
  headers: string[];
} | null {
  // 收集所有可能的行容器
  const rowCandidates = root.querySelectorAll(
    'tr, [role="row"], [class*="table-row"], [class*="tableRow"], [class*="row"]'
  );
  if (rowCandidates.length < 2) return null;

  const rows: HTMLElement[] = [];
  for (const rc of Array.from(rowCandidates)) {
    const el = rc as HTMLElement;
    if (!isVisible(el)) continue;
    rows.push(el);
  }
  if (rows.length < 2) return null;

  // 提取第一行作为列头
  const headerRow = rows[0];
  const headerCells = headerRow.querySelectorAll(
    'td, th, [role="cell"], [role="gridcell"], [role="columnheader"]'
  );
  if (headerCells.length < 2) return null;

  const headers = Array.from(headerCells)
    .map((c) => c.textContent?.trim() || '')
    .filter(Boolean);

  if (headers.length < 2) return null;

  return { tableRoot: root, headers };
}

/**
 * 识别单元格内输入元素的类型。
 */
function detectCellInputType(el: HTMLElement): TableModalCell['type'] {
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea') return 'textarea';
  if (tag === 'select') return 'select';
  if (tag === 'input') {
    const type = (el as HTMLInputElement).type?.toLowerCase();
    if (type === 'checkbox' || type === 'radio' || type === 'switch') return 'toggle';
    return 'input';
  }
  if (el.isContentEditable) return 'contenteditable';

  // 检查是否为开关组件（ant-switch 等）
  if (
    el.getAttribute('role') === 'switch' ||
    el.className?.toString().includes('switch') ||
    el.querySelector('[role="switch"]')
  ) {
    return 'toggle';
  }
  return 'input';
}

/**
 * 扫描页面上的表格型弹窗。
 * 自动查找可见弹窗容器，在弹窗内识别表格结构并提取行列信息。
 */
export function scanTableModal(): TableModalInfo {
  try {
    const modals = findVisibleModals();
    for (const modal of modals) {
      const result = scanModalForTable(modal);
      if (result) {
        return {
          ...result,
          modalSelector: buildSelector(modal),
        };
      }
    }
  } catch (err) {
    console.warn('[FormSnap] scanTableModal 异常:', err);
  }

  return { detected: false, rows: [], headers: [], modalSelector: '' };
}

/**
 * 对单个弹窗容器执行表格扫描。
 */
function scanModalForTable(modal: HTMLElement): Omit<TableModalInfo, 'modalSelector'> | null {
  const tableInfo = findTableStructure(modal);
  if (!tableInfo) return null;

  const { tableRoot, headers } = tableInfo;
  if (!tableRoot) return null;
  const rows: TableModalRow[] = [];

  // 判断是原生 table 还是 div 网格
  const isNativeTable = tableRoot.tagName.toLowerCase() === 'table';
  const allRows = isNativeTable
    ? Array.from(tableRoot.querySelectorAll('tbody tr, tr'))
    : Array.from(
        tableRoot.querySelectorAll(
          'tr, [role="row"], [class*="table-row"], [class*="tableRow"]'
        )
      );

  // 跳过第一行（列头行）
  const dataRows = allRows.slice(1);

  dataRows.forEach((rowEl, rowIdx) => {
    const cells: TableModalCell[] = [];
    const rowHTMLElement = rowEl as HTMLElement;

    // 获取行内所有单元格
    const cellElements = isNativeTable
      ? Array.from(rowEl.querySelectorAll('td'))
      : Array.from(
          rowEl.querySelectorAll(
            'td, [role="cell"], [role="gridcell"]'
          )
        );

    cellElements.forEach((cellEl, colIdx) => {
      const cell = cellEl as HTMLElement;

      // 在单元格内查找输入元素
      const inputEl =
        cell.querySelector('input:not([type="hidden"]):not([type="submit"])') as HTMLElement | null ||
        cell.querySelector('textarea') as HTMLElement | null ||
        cell.querySelector('select') as HTMLElement | null ||
        cell.querySelector('[contenteditable="true"], [contenteditable=""]') as HTMLElement | null ||
        cell.querySelector('[role="switch"], .ant-switch, .el-switch') as HTMLElement | null;

      if (inputEl) {
        const inputType = detectCellInputType(inputEl);
        // 跳过 toggle 类型元素（通常是功能开关，不存储用户数据）
        if (inputType === 'toggle') return;
        cells.push({
          colIndex: colIdx,
          headerName: headers[colIdx] || `列${colIdx + 1}`,
          element: inputEl,
          type: inputType,
          selector: buildSelector(inputEl),
        });
      }
    });

    if (cells.length > 0) {
      rows.push({ rowIndex: rowIdx, cells });
    }
  });

  if (rows.length === 0 && headers.length < 2) return null;

  // 即使没有数据行，只要有有效的列头就返回（用户需要先"新增"行）
  return { detected: true, rows, headers };
}

// ========================== 2. 表格填写 ==========================

/**
 * 根据映射数据填写表格弹窗。
 * @param mappings   映射列表（源字段 → 目标列头名）
 * @param tableInfo  scanTableModal 返回的表格信息
 */
export async function fillTableModal(
  mappings: TableMapping[],
  tableInfo: TableModalInfo
): Promise<{ success: number; failed: number; errors: string[] }> {
  const result = { success: 0, failed: 0, errors: [] as string[] };

  if (!tableInfo.detected || tableInfo.rows.length === 0) {
    result.errors.push('未检测到表格弹窗');
    return result;
  }

  for (const mapping of mappings) {
    try {
      // 遍历所有行，找到目标列头对应的单元格，填写所有匹配行
      let filled = false;
      for (const row of tableInfo.rows) {
        const targetCell = row.cells.find(
          (c) => c.headerName === mapping.targetHeaderName
        );
        if (!targetCell) continue;

        // 重新从 DOM 中获取元素（防止引用失效）
        const el = document.querySelector(targetCell.selector) as HTMLElement | null;
        if (!el) {
          result.errors.push(`元素未找到: ${targetCell.selector}`);
          continue;
        }

        fillSingleCell(el, mapping.sourceValue, targetCell.type);
        filled = true;
        // 不 break，继续填写后续匹配行
      }

      if (!filled) {
        result.errors.push(`未找到列 "${mapping.targetHeaderName}"`);
        result.failed++;
      } else {
        result.success++;
      }
    } catch (err) {
      result.errors.push(
        `填写 "${mapping.targetHeaderName}" 失败: ${err instanceof Error ? err.message : String(err)}`
      );
      result.failed++;
    }

    // 每填一个字段间隔 100ms，避免触发反爬检测
    await delay(100);
  }

  return result;
}

/**
 * 填写单个单元格。
 */
function fillSingleCell(
  el: HTMLElement,
  value: string,
  type: TableModalCell['type']
): void {
  switch (type) {
    case 'input':
    case 'textarea':
      setNativeValue(el, value);
      // 额外聚焦以确保光标位置正确
      (el as HTMLInputElement).focus();
      break;

    case 'contenteditable':
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      break;

    case 'select':
      fillSelect(el as HTMLSelectElement, value);
      break;

    case 'toggle':
      fillToggle(el, value);
      break;
  }
}

/**
 * 填写 select 元素：找到匹配 option 并设置。
 */
function fillSelect(el: HTMLSelectElement, value: string): void {
  const options = Array.from(el.options);
  // 优先按 value 属性匹配，其次按显示文本匹配
  const matchedOption =
    options.find((opt) => opt.value === value) ||
    options.find((opt) => opt.textContent?.trim() === value);

  if (matchedOption) {
    el.value = matchedOption.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * 填写 toggle/switch 元素。
 * 根据值的布尔含义决定是否需要切换当前状态。
 */
function fillToggle(el: HTMLElement, value: string): void {
  const booleanValue = parseBoolean(value);
  const currentState = getToggleState(el);

  // 如果当前状态与期望不同，则点击切换
  if (currentState !== booleanValue) {
    el.click();
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    // Also try React-compatible click
    el.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`[FormSnap] Toggle: ${currentState} → ${booleanValue}, clicked`, el.className);
  } else {
    console.log(`[FormSnap] Toggle: already ${booleanValue}, skip`);
  }
}

/**
 * 获取 toggle 的当前布尔状态。
 */
function getToggleState(el: HTMLElement): boolean {
  // 对于 input[type="checkbox"]
  if (el.tagName.toLowerCase() === 'input') {
    return (el as HTMLInputElement).checked;
  }
  // 对于 aria-checked
  const ariaChecked = el.getAttribute('aria-checked');
  if (ariaChecked !== null) {
    return ariaChecked === 'true';
  }
  // 对于 class 判断（ant-switch-checked 等）
  const classStr = el.className?.toString() || '';
  return classStr.includes('checked') || classStr.includes('active');
}

/**
 * 将字符串解析为布尔值。
 * 支持 "true"/"false"、"是"/"否"、"1"/"0" 等。
 */
function parseBoolean(value: string): boolean {
  const lower = value.trim().toLowerCase();
  if (['true', '1', '是', 'yes', 'on', '开启', 'checked'].includes(lower)) {
    return true;
  }
  if (['false', '0', '否', 'no', 'off', '关闭', 'unchecked'].includes(lower)) {
    return false;
  }
  // 非空字符串视为 true
  return value.trim().length > 0;
}

// ========================== 3. 点击新增行 ==========================

/**
 * 在表格弹窗内查找并点击"新增"按钮。
 * @param tableInfo  scanTableModal 的返回结果
 * @returns 是否成功点击
 */
export async function addTableRow(tableInfo: TableModalInfo): Promise<boolean> {
  try {
    const modalEl = document.querySelector(tableInfo.modalSelector) as HTMLElement | null;
    if (!modalEl) return false;

    // 查找包含"新增"、"添加"、"新建"等文字的按钮
    const keywords = ['新增', '添加', '新建', '添加行', '+ 新增', '+ 新建'];
    const buttons = modalEl.querySelectorAll(
      'button, [role="button"], a, span, div'
    );

    for (const btn of Array.from(buttons)) {
      const el = btn as HTMLElement;
      const text = (el.textContent || '').trim();
      const ariaLabel = (el.getAttribute('aria-label') || '').trim();
      const title = (el.getAttribute('title') || '').trim();
      const combined = `${text} ${ariaLabel} ${title}`;

      for (const kw of keywords) {
        if (combined.includes(kw)) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          // 派发完整的鼠标事件序列，确保框架事件处理生效
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          el.click();
          return true;
        }
      }
    }

    return false;
  } catch (err) {
    console.warn('[FormSnap] addTableRow 异常:', err);
    return false;
  }
}

// ========================== 4. 等待并重新扫描 ==========================

/**
 * 等待指定时间后重新扫描表格弹窗。
 * 用于新增行后等待 DOM 渲染完成。
 * @param timeout 等待时间（毫秒），默认 500
 */
export async function waitForAndScan(timeout: number = 500): Promise<TableModalInfo> {
  await delay(timeout);
  return scanTableModal();
}

// ========================== 3.5 Agent 多行自动填写 ==========================

/**
 * Agent 多行自动填写：自动点击"新增"按钮，逐行填入数据。
 * @param dataRows 每行数据的数组，每个元素是 { fieldName, value }[]
 * @param tableInfo 表格信息
 * @param onProgress 进度回调（可选）
 */
export async function fillTableModalMultiRow(
  dataRows: { fieldName: string; value: string }[][],
  tableInfo: TableModalInfo
): Promise<{ totalRows: number; filledRows: number; errors: string[] }> {
  const result = { totalRows: dataRows.length, filledRows: 0, errors: [] as string[] };

  if (!tableInfo.detected) {
    result.errors.push('未检测到表格弹窗');
    return result;
  }

  try {
    // 1. 检查当前已有的行数
    let currentInfo = scanTableModal();
    const existingRowCount = currentInfo.rows.length;

    // 2. 如果已有行数不足，需要新增行
    const rowsToAdd = dataRows.length - existingRowCount;
    if (rowsToAdd > 0) {
      for (let i = 0; i < rowsToAdd; i++) {
        try {
          const added = await addTableRow(currentInfo);
          if (!added) {
            result.errors.push(`第 ${i + 1} 次点击"新增"按钮失败`);
            break;
          }
          // 等待新行渲染
          await delay(800);
          // 重新扫描表格获取新行的 DOM 引用
          currentInfo = scanTableModal();
        } catch (err) {
          result.errors.push(`新增第 ${i + 1} 行时出错: ${err instanceof Error ? err.message : String(err)}`);
          break;
        }
      }
    }

    // 3. 逐行填写
    for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
      const rowData = dataRows[rowIdx];
      const targetRow = currentInfo.rows[rowIdx];

      if (!targetRow) {
        result.errors.push(`第 ${rowIdx + 1} 行在表格中不存在`);
        continue;
      }

      let rowFilled = 0;
      for (const field of rowData) {
        try {
          // 在当前行中找到对应列头的单元格
          const targetCell = targetRow.cells.find(
            (c) => c.headerName === field.fieldName
          );
          if (!targetCell) continue;

          // 重新从 DOM 获取元素引用
          const el = document.querySelector(targetCell.selector) as HTMLElement | null;
          if (!el) {
            result.errors.push(`第 ${rowIdx + 1} 行 "${field.fieldName}" 元素未找到`);
            continue;
          }

          fillSingleCell(el, field.value, targetCell.type);
          rowFilled++;
          // 每填一个字段间隔 150ms
          await delay(150);
        } catch (err) {
          result.errors.push(`第 ${rowIdx + 1} 行 "${field.fieldName}" 填写失败: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if (rowFilled > 0) {
        result.filledRows++;
      }
    }
  } catch (err) {
    result.errors.push(`多行填写过程出错: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

// ========================== 5. 页面模式检测 ==========================

/**
 * 检测当前页面属于哪种模式。
 * 通过启发式规则判断页面结构类型。
 */
export function detectPageMode(): PageModeResult {
  try {
    // ---- Canvas + SpreadJS 检测 ----
    const canvasCount = document.querySelectorAll('canvas').length;
    let hasSpreadJS = false;
    try {
      hasSpreadJS = !!(
        (window as any).GC?.Spread?.Sheets ||
        document.querySelector('.gc-spread-sheets, [class*="gc-spread"], [class*="spreadjs"]')
      );
    } catch {
      // 忽略
    }
    if (canvasCount >= 3 || hasSpreadJS) {
      return {
        mode: 'canvas-spreadsheet',
        confidence: hasSpreadJS ? 0.95 : 0.7,
        reason: hasSpreadJS
          ? `检测到 SpreadJS 实例，canvas 数量: ${canvasCount}`
          : `检测到 ${canvasCount} 个 canvas 元素，疑似 Canvas 电子表格`,
      };
    }

    // ---- 弹窗内表格检测 ----
    const modals = findVisibleModals();
    for (const modal of modals) {
      const tableInfo = findTableStructure(modal);
      if (tableInfo && tableInfo.headers.length >= 2) {
        return {
          mode: 'table-modal',
          confidence: 0.85,
          reason: `检测到可见弹窗包含表格结构，列头: [${tableInfo.headers.join(', ')}]`,
        };
      }
    }
    // 弹窗存在但无表格结构也算 table-modal（可能是空表格）
    if (modals.length > 0) {
      return {
        mode: 'table-modal',
        confidence: 0.55,
        reason: `检测到 ${modals.length} 个可见弹窗，但未找到明确表格结构`,
      };
    }

    // ---- 标准表单检测 ----
    const formInputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), select, textarea'
    );
    const mainInputs = Array.from(formInputs).filter((el) => {
      // 排除弹窗内的输入
      for (const modal of modals) {
        if (modal.contains(el)) return false;
      }
      return isVisible(el as HTMLElement);
    });
    if (mainInputs.length >= 3) {
      return {
        mode: 'standard-form',
        confidence: 0.8,
        reason: `在主页面检测到 ${mainInputs.length} 个表单输入元素`,
      };
    }

    // ---- 设置面板检测 ----
    // 多个 section/title + 少量输入（<3）
    const sections = document.querySelectorAll(
      'section, [role="region"], [class*="section"], [class*="Section"], [class*="panel"], [class*="Panel"]'
    );
    const headings = document.querySelectorAll('h1, h2, h3, [role="heading"]');
    if ((sections.length >= 2 || headings.length >= 3) && mainInputs.length < 3 && mainInputs.length > 0) {
      return {
        mode: 'settings-panel',
        confidence: 0.65,
        reason: `检测到 ${sections.length} 个 section 和 ${headings.length} 个标题，少量输入元素（${mainInputs.length} 个）`,
      };
    }

    // ---- 未知模式 ----
    return {
      mode: 'unknown',
      confidence: 0.3,
      reason: '未匹配到任何已知页面模式',
    };
  } catch (err) {
    console.warn('[FormSnap] detectPageMode 异常:', err);
    return {
      mode: 'unknown',
      confidence: 0,
      reason: `检测过程出错: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ========================== 6. 逐行新增填写引擎（小建工风格）==========================

/**
 * 逐行新增填写：适用于"只有一行输入框 + 新增按钮"的场景（如小建工变量编辑器）。
 * 流程：点击"+ 新增" → 等待新行出现 → 扫描当前行的输入框 → 依次填入字段值 → 循环。
 *
 * @param dataRows 每行数据的数组，每行是 { colName, value, type }[]
 * @param addButtonSelector "+ 新增"按钮的选择器（可选，自动查找）
 */
export async function fillRowByRowAgent(
  dataRows: { colName: string; value: string; type: string }[][],
  addButtonSelector?: string
): Promise<{ totalRows: number; filledRows: number; errors: string[] }> {
  const result = { totalRows: dataRows.length, filledRows: 0, errors: [] as string[] };

  // Snapshot current input count before we start
  let prevInputCount = 0;
  let prevToggleCount = 0;

  for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
    const rowData = dataRows[rowIdx];
    try {
      if (rowIdx > 0) {
        // Click "+ 新增" button
        let added = false;
        if (addButtonSelector) {
          const btn = document.querySelector(addButtonSelector) as HTMLElement | null;
          if (btn) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            await delay(300);
            btn.click();
            added = true;
          }
        }
        if (!added) {
          const addButtons = document.querySelectorAll(
            'button, a, span, div[role="button"], [class*="add"], [class*="Add"], [class*="new"], [class*="New"]'
          );
          for (const btn of Array.from(addButtons)) {
            const el = btn as HTMLElement;
            const text = el.textContent?.trim() || '';
            if (text.match(/^[+＋]\s*新增|^新增|^[+＋]\s*Add|^Add|^添加|^创建/)) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await delay(300);
              el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
              el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
              el.click();
              added = true;
              break;
            }
          }
        }
        if (!added) {
          result.errors.push(`第 ${rowIdx + 1} 行：找不到"+ 新增"按钮`);
          continue;
        }
        // Wait for new row to render
        await delay(1000);
      } else {
          // First row: snapshot current counts (this row already exists)
          const allInputs = getAllRowInputs();
          const allToggles = getAllToggles();
          prevInputCount = allInputs.length;
          prevToggleCount = allToggles.length;
          console.log(`[FormSnap] Row 0: ${prevInputCount} inputs, ${prevToggleCount} toggles`);
        }

      // Scan inputs: only get the NEW ones (after prevInputCount)
      const allInputsNow = getAllRowInputs();
      const newInputs = allInputsNow.slice(prevInputCount);
      const newToggleCount = getAllToggles().length;
      // For toggles: use the last N toggles that appeared after the previous row

      let rowFilled = 0;
      let inputIdx = 0;
      let toggleIdx = 0;

      for (const field of rowData) {
        if (field.type === 'checkbox' || field.type === 'toggle') {
          const allTogglesNow = getAllToggles();
          if (toggleIdx < allTogglesNow.length - prevToggleCount) {
            const toggleEl = allTogglesNow[prevToggleCount + toggleIdx];
            fillToggle(toggleEl, field.value);
            rowFilled++;
            toggleIdx++;
            await delay(100);
          }
          continue;
        }

        if (inputIdx < newInputs.length) {
          const inputEl = newInputs[inputIdx];
          setNativeValue(inputEl, field.value);
          // Ensure React picks up the change even for empty values
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
          (inputEl as HTMLInputElement)?.focus?.();
          console.log(`[FormSnap] Fill: "${field.colName}" = "${field.value}" into`, inputEl);
          rowFilled++;
          inputIdx++;
          await delay(150);
        } else {
          result.errors.push(`第 ${rowIdx + 1} 行 "${field.colName}"：找不到对应输入框`);
        }
      }

      // Update prev counts for next iteration
      prevInputCount = allInputsNow.length;
      prevToggleCount = getAllToggles().length;

      if (rowFilled > 0) result.filledRows++;
      await delay(200);
    } catch (err) {
      result.errors.push(`第 ${rowIdx + 1} 行出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return result;
}

/**
 * 获取弹窗内所有可见输入元素，按 DOM 顺序排列。
 * 覆盖多种框架：标准 input/textarea、contenteditable、Ant Design Input、自定义编辑器。
 */
function getAllRowInputs(): HTMLElement[] {
  const inputs: HTMLElement[] = [];
  const modals = findVisibleModals();
  const scope = modals.length > 0 ? modals[0] : document.body;

  // Strategy 1: Standard inputs
  scope.querySelectorAll(
    'input[type="text"], input:not([type]), textarea'
  ).forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (isVisible(htmlEl)) inputs.push(htmlEl);
  });

  // Strategy 2: contenteditable elements (rich text editors, Ant Design Input.TextArea, etc.)
  scope.querySelectorAll(
    '[contenteditable="true"], [contenteditable=""]'
  ).forEach((el) => {
    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect();
    // Filter: only include reasonably-sized editable elements
    if (rect.width > 20 && rect.height > 10 && isVisible(htmlEl)) {
      // Skip if already inside a scanned input/textarea
      if (!htmlEl.closest('input, textarea')) {
        inputs.push(htmlEl);
      }
    }
  });

  // Strategy 3: Ant Design Input wrapper (.ant-input, .ant-input-affix-wrapper)
  scope.querySelectorAll(
    '.ant-input, .ant-input-affix-wrapper, .ant-input-textarea textarea'
  ).forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (isVisible(htmlEl) && !inputs.includes(htmlEl)) {
      inputs.push(htmlEl);
    }
  });

  // Strategy 4: ProseMirror/TipTap editors (often used in modern editors)
  scope.querySelectorAll(
    '.ProseMirror, .tiptap, [class*="editor-content"], [class*="Editor-content"]'
  ).forEach((el) => {
    const htmlEl = el as HTMLElement;
    const rect = htmlEl.getBoundingClientRect();
    if (rect.width > 20 && rect.height > 10 && isVisible(htmlEl)) {
      inputs.push(htmlEl);
    }
  });

  // Sort by DOM position
  inputs.sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  console.log(`[FormSnap] getAllRowInputs found ${inputs.length} inputs`, inputs.map((el) => ({
    tag: el.tagName,
    class: el.className?.toString().slice(0, 50),
    size: `${Math.round(el.getBoundingClientRect().width)}x${Math.round(el.getBoundingClientRect().height)}`,
  })));

  return inputs;
}

/**
 * 获取弹窗内所有开关元素。
 */
function getAllToggles(): HTMLElement[] {
  const modals = findVisibleModals();
  const scope = modals.length > 0 ? modals[0] : document.body;

  const toggles: HTMLElement[] = [];
  scope.querySelectorAll(
    '[role="switch"], .ant-switch, .el-switch, [class*="switch"]'
  ).forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (isVisible(htmlEl)) toggles.push(htmlEl);
  });

  console.log(`[FormSnap] getAllToggles found ${toggles.length} in scope:`,
    scope.tagName + (scope.id ? '#' + scope.id : '') + (scope.className ? '.' + scope.className.toString().slice(0, 40) : ''));

  return toggles;
}

/**

/**
 * 常量：消息类型枚举
 */
export const AGENT_MESSAGE_TYPES = {
  EXEC_SCAN_TABLE_MODAL: 'EXEC_SCAN_TABLE_MODAL',
  EXEC_FILL_TABLE_MODAL: 'EXEC_FILL_TABLE_MODAL',
  EXEC_ADD_TABLE_ROW: 'EXEC_ADD_TABLE_ROW',
  EXEC_DETECT_PAGE_MODE: 'EXEC_DETECT_PAGE_MODE',
  EXEC_FILL_TABLE_MULTI_ROW: 'EXEC_FILL_TABLE_MULTI_ROW',
  EXEC_FILL_ROW_BY_ROW: 'EXEC_FILL_ROW_BY_ROW',
} as const;

chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: any }, sender, sendResponse) => {
    // sender.id 校验，确保消息来自本扩展
    if (sender.id !== chrome.runtime.id) return false;

    try {
      switch (message.type) {
        case AGENT_MESSAGE_TYPES.EXEC_SCAN_TABLE_MODAL: {
          const result = scanTableModal();
          sendResponse(result);
          return false;
        }

        case AGENT_MESSAGE_TYPES.EXEC_FILL_TABLE_MODAL: {
          const { mappings, tableInfo } = message.payload as {
            mappings: TableMapping[];
            tableInfo: TableModalInfo;
          };
          fillTableModal(mappings, tableInfo).then(sendResponse);
          return true; // 异步响应
        }

        case AGENT_MESSAGE_TYPES.EXEC_ADD_TABLE_ROW: {
          const { tableInfo } = message.payload as { tableInfo: TableModalInfo };
          addTableRow(tableInfo).then(sendResponse);
          return true; // 异步响应
        }

        case AGENT_MESSAGE_TYPES.EXEC_DETECT_PAGE_MODE: {
          const result = detectPageMode();
          sendResponse(result);
          return false;
        }

        case AGENT_MESSAGE_TYPES.EXEC_FILL_TABLE_MULTI_ROW: {
          const { dataRows, tableInfo } = message.payload as {
            dataRows: { fieldName: string; value: string }[][];
            tableInfo: TableModalInfo;
          };
          fillTableModalMultiRow(dataRows, tableInfo).then(sendResponse);
          return true;
        }

        case AGENT_MESSAGE_TYPES.EXEC_FILL_ROW_BY_ROW: {
          const { dataRows, addButtonSelector } = message.payload as {
            dataRows: { colName: string; value: string; type: string }[][];
            addButtonSelector?: string;
          };
          fillRowByRowAgent(dataRows, addButtonSelector).then(sendResponse);
          return true;
        }

        default:
          return false;
      }
    } catch (err) {
      // 捕获所有异常，避免冒泡到控制台
      sendResponse({ error: String(err) });
      return false;
    }
  }
);
