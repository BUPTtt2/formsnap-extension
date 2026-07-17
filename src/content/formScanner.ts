import { FormField, NewButtonInfo, ModalInfo } from './contentTypes';

type FieldType = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date' | 'number';

function detectFieldType(el: HTMLElement): FieldType {
  const tagName = el.tagName.toLowerCase();
  const type = (el as HTMLInputElement).type?.toLowerCase();
  if (tagName === 'textarea') return 'textarea';
  if (tagName === 'select') return 'select';
  if (tagName === 'input') {
    if (type === 'radio') return 'radio';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'date' || type === 'datetime-local' || type === 'month') return 'date';
    if (type === 'number') return 'number';
    return 'text';
  }
  if (el.isContentEditable) return 'text';
  return 'text';
}

/**
 * Find active/visible modal or dialog on the page.
 * Returns the innermost content container that contains form elements.
 */
function findActiveModal(): HTMLElement | null {
  const candidates: HTMLElement[] = [];

  // Phase 1: collect all visible modal-like elements
  const selectors = [
    '[role="dialog"]',
    '.ant-modal-wrap',
    '.el-dialog',
    '[aria-modal="true"]',
    '[class*="Modal"]:not([class*="modal-mask"]):not([class*="Mask"]):not([class*="modalWrap"])',
    '[class*="Drawer"]',
    '[class*="drawer"]',
    '.ant-drawer-content',
    '[class*="dialog"]',
    '.ant-modal-content',
    '.el-dialog__body',
    '.ant-drawer-body',
    '[class*="modal-body"]',
    '[class*="ModalBody"]',
    '[class*="drawer-body"]',
    // Coze / Dify style variable editors
    '[class*="variable"]',
    '[class*="Variable"]',
    '[class*="field-editor"]',
    '[class*="FieldEditor"]',
    '[class*="form-panel"]',
  ];
  for (const sel of selectors) {
    try {
      const nodes = document.querySelectorAll(sel);
      for (const node of Array.from(nodes)) {
        const el = node as HTMLElement;
        const style = window.getComputedStyle(el);
        if (style.display !== 'none' && style.visibility !== 'hidden') {
          candidates.push(el);
        }
      }
    } catch {
      // invalid selector, skip
    }
  }

  if (candidates.length === 0) return null;

  // Phase 2: prefer the candidate that contains the most input elements
  let best: HTMLElement | null = null;
  let bestCount = 0;
  for (const el of candidates) {
    const inputs = el.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), select, textarea, [contenteditable="true"], [contenteditable=""]'
    );
    if (inputs.length > bestCount) {
      bestCount = inputs.length;
      best = el;
    }
  }

  // Only return if we found at least one input in the modal
  return bestCount > 0 ? best : null;
}

/**
 * Get label for a contenteditable element.
 * Tries multiple strategies that work with both standard <table> and non-standard (div-based) grids.
 */
function getLabelForElement(el: HTMLElement): string {
  if (el.isContentEditable) {
    return getLabelForEditable(el);
  }

  // Strategy 0: form-item container (Ant Design, Element UI, etc.)
  const formItem = el.closest('.form-item, .ant-form-item, .el-form-item, [class*="form-item"], [class*="formItem"]');
  if (formItem) {
    const labelEl = formItem.querySelector('.form-item-label, .ant-form-item-label, .el-form-item__label, [class*="label"]');
    if (labelEl) {
      const text = labelEl.textContent?.trim();
      if (text) return text;
    }
    // Try first child as label
    const firstChild = formItem.firstElementChild;
    if (firstChild && firstChild !== el.closest('.form-item-content, .ant-form-item-control, .el-form-item__content')) {
      const text = firstChild.textContent?.trim();
      if (text && text.length < 50) return text;
    }
  }

  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) return label.textContent?.trim() || '';
  }
  const parentLabel = el.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input,select,textarea,[contenteditable]').forEach((c) => c.remove());
    const text = clone.textContent?.trim();
    if (text) return text;
  }

  // Strategy: sibling text nodes in parent
  const parent = el.parentElement;
  if (parent) {
    const directTexts = Array.from(parent.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())
      .map((n) => n.textContent!.trim());
    if (directTexts.length > 0 && directTexts[0].length < 50) return directTexts[0];

    // Strategy: previous sibling text
    const prevSibling = el.previousElementSibling;
    if (prevSibling) {
      const text = prevSibling.textContent?.trim();
      if (text && text.length < 50) return text;
    }
  }

  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) return refEl.textContent?.trim() || '';
  }
  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder) return placeholder.trim();
  const name = (el as HTMLInputElement).name;
  if (name) return name.replace(/[_-]/g, ' ');
  return '';
}

/**
 * Multi-strategy label extraction for contenteditable elements.
 * Works with: standard <table>, div-based grids, Canvas+overlay editors, and inherited contenteditable.
 */
function getLabelForEditable(el: HTMLElement): string {
  // Strategy 0: Check data attributes on the element or its close ancestors
  const selfOrParent = findClosestWithAttr(el, ['data-col-name', 'data-field', 'data-column', 'data-label', 'data-header']);
  if (selfOrParent) {
    for (const attr of ['data-col-name', 'data-field', 'data-column', 'data-label', 'data-header']) {
      const val = selfOrParent.getAttribute(attr);
      if (val) return val.trim();
    }
  }

  // Strategy 1: Standard <table> with <th> or <td> headers
  const cell = el.closest('td, [role="cell"], [role="gridcell"]');
  if (cell) {
    const table = cell.closest('table, [role="grid"], [role="table"]');
    if (table) {
      const row = cell.parentElement;
      if (row) {
        const cellIndex = Array.from(row.children).indexOf(cell);
        const allRows = table.querySelectorAll('tr, [role="row"]');
        // First pass: look for <th> or role="columnheader"
        for (const headerRow of allRows) {
          const headerCell = headerRow.children[cellIndex] as HTMLElement | undefined;
          if (headerCell) {
            const tag = headerCell.tagName?.toLowerCase();
            const role = headerCell.getAttribute('role');
            if (tag === 'th' || role === 'columnheader' || role === 'rowheader') {
              const text = headerCell.textContent?.trim();
              if (text) return text;
            }
          }
        }
        // Second pass: use first row's cell text as header (for tables using <td> for headers)
        for (const headerRow of allRows) {
          const headerCell = headerRow.children[cellIndex] as HTMLElement | undefined;
          if (headerCell) {
            const text = headerCell.textContent?.trim();
            if (text) return text;
          }
        }
      }
    }
  }

  // Strategy 2: Non-standard grid (div-based rows/columns)
  // Find a row container (parent with multiple siblings that look like rows)
  const label = findLabelInDivGrid(el);
  if (label) return label;

  // Strategy 3: Column header via aria-label / title on element or ancestors
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();
  const title = el.getAttribute('title');
  if (title) return title.trim();

  // Strategy 4: Look for a fixed header element above the cell
  const fixedHeader = findFixedColumnHeader(el);
  if (fixedHeader) return fixedHeader;

  // Strategy 5: Check for a visually associated label via aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) return refEl.textContent?.trim() || '';
  }

  return '';
}

/**
 * Try to find a column label in div-based grids (non-standard table structure).
 * Looks for repeating row patterns where each row has siblings at the same position.
 */
function findLabelInDivGrid(el: HTMLElement): string {
  // Walk up to find a container that has multiple children resembling rows
  let container: HTMLElement | null = el.parentElement;
  let depth = 0;
  while (container && depth < 10) {
    const children = Array.from(container.children);
    if (children.length >= 2) {
      // Check if these children look like rows (similar structure, multiple children each)
      const childCounts = children.map(c => c.children.length);
      const avgChildren = childCounts.reduce((a, b) => a + b, 0) / childCounts.length;
      if (avgChildren >= 2 && childCounts.every(c => c >= 1)) {
        // This looks like a grid! Find which column index our element is in
        const elRowIndex = children.findIndex(c => c.contains(el));
        if (elRowIndex >= 0) {
          const row = children[elRowIndex];
          const elColIndex = getChildIndex(row, el);
          // Get text from the same column in the first row (header row)
          const headerRow = children[0];
          if (headerRow !== row && elColIndex < headerRow.children.length) {
            const headerCell = headerRow.children[elColIndex] as HTMLElement;
            const text = headerCell.textContent?.trim();
            if (text) return text;
          }
        }
        break;
      }
    }
    container = container.parentElement;
    depth++;
  }
  return '';
}

/**
 * Try to find a fixed/sticky column header element that's positioned above the cell.
 * Common in spreadsheets where headers are in a fixed top bar.
 */
function findFixedColumnHeader(el: HTMLElement): string {
  const rect = el.getBoundingClientRect();
  // Look for elements at the top of the page that are vertically aligned with our cell
  // and have text content (likely column headers)
  const allTextEls = document.querySelectorAll(
    '[style*="position: fixed"], [style*="position:sticky"], th, .col-header, .column-header, .cell-header, [class*="header"]'
  );
  let bestMatch = '';
  let bestDist = Infinity;
  for (const headerEl of allTextEls) {
    const hRect = (headerEl as HTMLElement).getBoundingClientRect();
    // Header should be above the cell and horizontally overlapping
    if (hRect.bottom <= rect.top + 50 && hRect.right > rect.left && hRect.left < rect.right) {
      const hCenter = hRect.left + hRect.width / 2;
      const dist = Math.abs(hCenter - (rect.left + rect.width / 2));
      const text = headerEl.textContent?.trim();
      if (text && text.length < 50 && dist < bestDist) {
        bestDist = dist;
        bestMatch = text;
      }
    }
  }
  return bestMatch;
}

function getChildIndex(parent: Element, target: Element): number {
  let node: Element | null = target;
  while (node && node.parentElement !== parent) {
    node = node.parentElement;
  }
  if (!node) return -1;
  return Array.from(parent.children).indexOf(node);
}

function findClosestWithAttr(el: HTMLElement, attrs: string[]): HTMLElement | null {
  let current: HTMLElement | null = el;
  let depth = 0;
  while (current && depth < 5) {
    for (const attr of attrs) {
      if (current.hasAttribute(attr)) return current;
    }
    current = current.parentElement;
    depth++;
  }
  return null;
}

function getSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if ((el as HTMLInputElement).name) {
    return `${el.tagName.toLowerCase()}[name="${CSS.escape((el as HTMLInputElement).name)}"]`;
  }
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current !== document.body) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      parts.unshift(selector);
      break;
    }
    if (current.className && typeof current.className === 'string') {
      const classes = current.className.trim().split(/\s+/).slice(0, 2).join('.');
      if (classes) selector += `.${classes}`;
    }
    const parent = current.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
      if (siblings.length > 1) {
        const index = siblings.indexOf(current) + 1;
        selector += `:nth-of-type(${index})`;
      }
    }
    parts.unshift(selector);
    current = current.parentElement;
  }
  return parts.join(' > ');
}

/**
 * Generate a unique CSS selector for an element, even if it has no id/class.
 * Uses nth-child chains as a reliable fallback.
 */
function getSelectorRobust(el: HTMLElement): string {
  // Try standard selector first
  const standard = getSelector(el);
  if (standard && standard !== 'div' && standard !== 'span' && standard !== 'p') {
    // Verify it uniquely identifies the element
    const matches = document.querySelectorAll(standard);
    if (matches.length === 1) return standard;
  }

  // Fallback: build a full path with nth-child
  if (el.id) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let current: HTMLElement | null = el;
  while (current && current !== document.body && current !== document.documentElement) {
    let selector = current.tagName.toLowerCase();
    if (current.id) {
      selector = `#${CSS.escape(current.id)}`;
      parts.unshift(selector);
      break;
    }
    const parentNode: HTMLElement | null = current.parentElement;
    if (parentNode) {
      const idx = Array.from(parentNode.children).indexOf(current) + 1;
      selector += `:nth-child(${idx})`;
      parts.unshift(selector);
    }
    current = parentNode;
  }
  const robust = parts.join(' > ');
  // Verify uniqueness
  const matches = document.querySelectorAll(robust);
  if (matches.length === 1) return robust;
  // Last resort: append a unique attribute marker
  return robust;
}

function getOptionsForSelect(select: HTMLSelectElement): string[] {
  return Array.from(select.options).map((opt) => opt.text.trim()).filter(Boolean);
}

function getRadioGroupOptions(name: string): string[] {
  const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(name)}"]`);
  return Array.from(radios).map((r) => {
    const label = getLabelForElement(r as HTMLElement);
    return label || (r as HTMLInputElement).value;
  });
}

// ---------------------------------------------------------------------------
// Shadow DOM 递归遍历辅助函数
// ---------------------------------------------------------------------------

/**
 * 递归遍历 Shadow DOM，收集所有匹配选择器的输入元素。
 * 穿透 open mode 的 shadowRoot，在内部继续查找 input/textarea/select/contenteditable 元素。
 */
function walkShadowDOM(root: Element, results: HTMLElement[]): void {
  const selector = 'input, textarea, select, [contenteditable="true"], [contenteditable=""]';
  const found = root.querySelectorAll(selector);
  found.forEach((el) => {
    if (!results.includes(el as HTMLElement)) {
      results.push(el as HTMLElement);
    }
  });
  // 递归进入子元素的 shadowRoot
  const children = root.querySelectorAll('*');
  children.forEach((child) => {
    const shadowRoot = (child as HTMLElement).shadowRoot;
    if (shadowRoot) {
      walkShadowDOM(shadowRoot as any, results);
    }
  });
}

// ---------------------------------------------------------------------------
// Shadow DOM 辅助：在 shadowRoot 中查找表单元素
// ---------------------------------------------------------------------------

/**
 * 从所有 shadowRoot 中收集表单输入元素（input/textarea/select）。
 */
function collectShadowFormElements(): HTMLElement[] {
  const results: HTMLElement[] = [];
  // 收集页面中所有 open shadow root
  const allElements = document.querySelectorAll('*');
  allElements.forEach((el) => {
    const shadowRoot = (el as HTMLElement).shadowRoot;
    if (shadowRoot) {
      walkShadowDOM(shadowRoot as any, results);
    }
  });
  return results;
}

/**
 * 从所有 shadowRoot 中收集 contenteditable 元素。
 */
function collectShadowEditableElements(): HTMLElement[] {
  const results: HTMLElement[] = [];
  const allElements = document.querySelectorAll('*');
  allElements.forEach((el) => {
    const shadowRoot = (el as HTMLElement).shadowRoot;
    if (shadowRoot) {
      // 在 shadowRoot 内查找 contenteditable
      const editables = shadowRoot.querySelectorAll('[contenteditable="true"], [contenteditable=""]');
      editables.forEach((e) => {
        if (!results.includes(e as HTMLElement)) {
          results.push(e as HTMLElement);
        }
      });
      // 递归检查 shadowRoot 内的子元素是否也有 shadowRoot
      walkShadowDOMForEditables(shadowRoot as any, results);
    }
  });
  return results;
}

/**
 * 递归遍历 shadowRoot 内部，收集 contenteditable 元素。
 */
function walkShadowDOMForEditables(root: Element, results: HTMLElement[]): void {
  const children = root.querySelectorAll('*');
  children.forEach((child) => {
    const htmlChild = child as HTMLElement;
    if (htmlChild.isContentEditable && !results.includes(htmlChild)) {
      const rect = htmlChild.getBoundingClientRect();
      if (rect.width >= 20 && rect.height >= 12) {
        if (!(rect.height > 200 && rect.width > 500 && htmlChild.children.length > 20)) {
          results.push(htmlChild);
        }
      }
    }
    const shadowRoot = htmlChild.shadowRoot;
    if (shadowRoot) {
      walkShadowDOMForEditables(shadowRoot as any, results);
    }
  });
}

/**
 * Find all contenteditable elements on the page, including those with inherited contenteditable.
 * This catches cases where contenteditable is set on a parent container and children inherit it.
 * 现在支持穿透 Shadow DOM 查找。
 */
function findAllEditableElements(): HTMLElement[] {
  const results: HTMLElement[] = [];

  // Method 1: Explicit contenteditable attributes（主文档）
  const explicit = document.querySelectorAll('[contenteditable="true"], [contenteditable=""]');
  explicit.forEach((el) => results.push(el as HTMLElement));

  // Method 1.5: 从 Shadow DOM 中收集 contenteditable 元素
  const shadowEditables = collectShadowEditableElements();
  shadowEditables.forEach((el) => {
    if (!results.includes(el)) results.push(el);
  });

  // Method 2: Walk all visible elements and check isContentEditable property (catches inherited)
  // Only scan a reasonable depth to avoid performance issues
  const walk = (root: Element, maxDepth: number, depth: number = 0) => {
    if (depth > maxDepth) return;
    const children = root.children;
    if (!children) return;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child || child.nodeType !== 1) continue; // Skip non-Element nodes
      const htmlChild = child as HTMLElement;
      if (typeof htmlChild.getAttribute !== 'function') continue; // Safety check
      if (htmlChild.isContentEditable && !results.includes(htmlChild)) {
        // Skip if it's a large container (toolbar, panel, etc.)
        const rect = htmlChild.getBoundingClientRect();
        if (rect.width < 20 || rect.height < 12) continue;
        if (rect.height > 200 && rect.width > 500 && htmlChild.children.length > 20) continue;
        results.push(htmlChild);
      }
      // Don't recurse into already-found editables (they are containers, we want their children)
      if (!results.includes(htmlChild)) {
        walk(htmlChild, maxDepth, depth + 1);
      }
    }
  };
  walk(document.body, 15);

  return results;
}

export function scanPageForms(): FormField[] {
  const fields: FormField[] = [];
  const seenSelectors = new Set<string>();
  const processedRadioGroups = new Set<string>();

  // 1. Detect active modal/dialog
  const activeModal = findActiveModal();
  const isModalMode = !!activeModal;

  // 2. Scan standard form elements within scope
  let inputs: NodeListOf<Element>;
  if (activeModal) {
    inputs = activeModal.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), select, textarea'
    );
  } else {
    inputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), select, textarea'
    );
  }

  // 3. Collect Shadow DOM form elements (filter by modal scope if in modal mode)
  const shadowInputs = collectShadowFormElements().filter((el) => {
    if (isModalMode) return activeModal!.contains(el) || activeModal!.querySelector(`[id="${CSS.escape(el.id)}"]`) !== null;
    return true;
  });

  // 4. Merge and deduplicate
  const mainInputSet = new Set(inputs);
  const allInputs: Element[] = Array.from(inputs);
  shadowInputs.forEach((el) => {
    if (!mainInputSet.has(el)) {
      allInputs.push(el);
    }
  });

  allInputs.forEach((el) => {
    const htmlEl = el as HTMLElement;
    const type = detectFieldType(htmlEl);
    const label = getLabelForElement(htmlEl);

    if (type === 'radio') {
      const name = (el as HTMLInputElement).name;
      if (!name || processedRadioGroups.has(name)) return;
      processedRadioGroups.add(name);
      const selector = `input[type="radio"][name="${CSS.escape(name)}"]`;
      if (seenSelectors.has(selector)) return;
      seenSelectors.add(selector);
      fields.push({
        selector, label, type: 'radio', name,
        options: getRadioGroupOptions(name),
        radioGroup: name,
      });
      return;
    }

    const selector = getSelector(htmlEl);
    if (seenSelectors.has(selector)) return;
    seenSelectors.add(selector);

    const field: FormField = {
      selector, label, type,
      name: (el as HTMLInputElement).name || undefined,
      id: el.id || undefined,
      placeholder: (el as HTMLInputElement).placeholder || undefined,
      tagName: el.tagName.toLowerCase(),
    };

    if (type === 'select') {
      field.options = getOptionsForSelect(el as HTMLSelectElement);
    }
    fields.push(field);
  });

  // 5. Scan contenteditable elements (scoped to modal if in modal mode)
  const editables = findAllEditableElements().filter((el) => {
    if (isModalMode) return activeModal!.contains(el);
    return true;
  });
  const seenElements = new Set<Element>();

  editables.forEach((el) => {
    if (seenElements.has(el)) return;
    seenElements.add(el);

    const htmlEl = el as HTMLElement;
    // Skip if this is inside an already-scanned input/textarea/select
    if (htmlEl.closest('input, textarea, select')) return;
    // Skip very small or invisible elements
    const rect = htmlEl.getBoundingClientRect();
    if (rect.width < 20 || rect.height < 12) return;
    const style = window.getComputedStyle(htmlEl);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;

    // Skip if it's a container that contains other already-found editables
    const containsOther = editables.some(other => other !== htmlEl && htmlEl.contains(other));
    if (containsOther) return;

    const selector = getSelectorRobust(htmlEl);
    if (seenSelectors.has(selector)) return;

    seenSelectors.add(selector);

    const label = getLabelForElement(htmlEl);
    fields.push({
      selector,
      label: label || `单元格 ${fields.length + 1}`,
      type: 'text',
      name: htmlEl.getAttribute('data-field') || htmlEl.getAttribute('name') || undefined,
      id: htmlEl.id || undefined,
      placeholder: htmlEl.getAttribute('data-placeholder') || htmlEl.getAttribute('placeholder') || undefined,
      tagName: htmlEl.tagName.toLowerCase(),
    });
  });

  // Fallback: if modal scan returned empty, retry with full page scan
  if (isModalMode && fields.length === 0) {
    const fallbackInputs = document.querySelectorAll(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), select, textarea'
    );
    const fallbackShadow = collectShadowFormElements();
    const fallbackAll: Element[] = Array.from(fallbackInputs);
    fallbackShadow.forEach((el) => {
      if (!fallbackAll.includes(el)) fallbackAll.push(el);
    });

    fallbackAll.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const type = detectFieldType(htmlEl);
      const label = getLabelForElement(htmlEl);

      if (type === 'radio') {
        const name = (el as HTMLInputElement).name;
        if (!name || processedRadioGroups.has(name)) return;
        processedRadioGroups.add(name);
        const selector = `input[type="radio"][name="${CSS.escape(name)}"]`;
        if (seenSelectors.has(selector)) return;
        seenSelectors.add(selector);
        fields.push({
          selector, label, type: 'radio', name,
          options: getRadioGroupOptions(name),
          radioGroup: name,
        });
        return;
      }

      const selector = getSelector(htmlEl);
      if (seenSelectors.has(selector)) return;
      seenSelectors.add(selector);

      const field: FormField = {
        selector, label, type,
        name: (el as HTMLInputElement).name || undefined,
        id: el.id || undefined,
        placeholder: (el as HTMLInputElement).placeholder || undefined,
        tagName: el.tagName.toLowerCase(),
      };
      if (type === 'select') {
        field.options = getOptionsForSelect(el as HTMLSelectElement);
      }
      fields.push(field);
    });

    // Also scan editables
    const fallbackEditables = findAllEditableElements();
    fallbackEditables.forEach((el) => {
      if (seenElements.has(el)) return;
      seenElements.add(el);
      const htmlEl = el as HTMLElement;
      if (htmlEl.closest('input, textarea, select')) return;
      const rect = htmlEl.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 12) return;
      const style = window.getComputedStyle(htmlEl);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return;
      const containsOther = fallbackEditables.some((other) => other !== htmlEl && htmlEl.contains(other));
      if (containsOther) return;
      const selector = getSelectorRobust(htmlEl);
      if (seenSelectors.has(selector)) return;
      seenSelectors.add(selector);
      const label = getLabelForElement(htmlEl);
      fields.push({
        selector,
        label: label || `单元格 ${fields.length + 1}`,
        type: 'text',
        name: htmlEl.getAttribute('data-field') || htmlEl.getAttribute('name') || undefined,
        id: htmlEl.id || undefined,
        placeholder: htmlEl.getAttribute('data-placeholder') || htmlEl.getAttribute('placeholder') || undefined,
        tagName: htmlEl.tagName.toLowerCase(),
      });
    });
  }

  return fields;
}

const NEW_BUTTON_KEYWORDS = ['新建', '新增', '添加', '创建', 'Add', 'New', 'Create', 'plus', '+'];

function looksLikeNewButton(el: HTMLElement): boolean {
  const text = (el.textContent || '').trim().toLowerCase();
  const ariaLabel = (el.getAttribute('aria-label') || '').trim().toLowerCase();
  const title = (el.getAttribute('title') || '').trim().toLowerCase();
  const className = (el.className || '').toLowerCase();

  for (const kw of NEW_BUTTON_KEYWORDS) {
    const lowerKw = kw.toLowerCase();
    if (text.includes(lowerKw) || ariaLabel.includes(lowerKw) || title.includes(lowerKw)) return true;
  }

  if (className.includes('add') || className.includes('new') || className.includes('create') || className.includes('plus')) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || el.getAttribute('role') === 'button') return true;
    const style = window.getComputedStyle(el);
    if (style.cursor === 'pointer') return true;
  }

  return false;
}

export function detectNewButtons(): NewButtonInfo[] {
  const buttons: NewButtonInfo[] = [];
  const seen = new Set<string>();

  const candidates = document.querySelectorAll('button, a, [role="button"], div, span, i, svg');
  candidates.forEach((el) => {
    const htmlEl = el as HTMLElement;
    if (!looksLikeNewButton(htmlEl)) return;
    const selector = getSelector(htmlEl);
    if (seen.has(selector)) return;
    seen.add(selector);
    buttons.push({
      text: (htmlEl.textContent || '').trim().slice(0, 50),
      selector,
      tagName: htmlEl.tagName.toLowerCase(),
    });
  });

  return buttons
    .sort((a, b) => a.text.length - b.text.length)
    .slice(0, 5);
}

export function clickNewButton(selector: string): boolean {
  const el = document.querySelector(selector) as HTMLElement | null;
  if (!el) return false;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.click();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
}

export function waitForFormFields(timeoutMs: number = 3000): Promise<FormField[]> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const fields = scanPageForms();
      if (fields.length > 0 || Date.now() - start > timeoutMs) {
        resolve(fields);
        return;
      }
      setTimeout(check, 300);
    };
    check();
  });
}

// ---------------------------------------------------------------------------
// 弹窗/模态框/抽屉检测
// ---------------------------------------------------------------------------

/** 可能触发弹窗/模态框/抽屉的按钮关键词 */
const MODAL_TRIGGER_KEYWORDS = [
  '设置', '编辑', '配置', '详情', '查看', '修改', '更多',
  'setting', 'edit', 'config', 'configure', 'detail', 'more', 'option',
];

/** 可能表示弹窗/抽屉关闭的按钮关键词 */
const MODAL_CLOSE_KEYWORDS = [
  '关闭', '取消', 'close', 'cancel', 'dismiss',
];

/**
 * 检测页面上弹窗/模态框/抽屉的触发按钮或关闭按钮。
 * 返回匹配到的按钮信息列表。
 */
export function detectModalOrDrawer(): ModalInfo[] {
  const results: ModalInfo[] = [];
  const seen = new Set<string>();

  // 1. 检测当前已打开的弹窗/模态框/抽屉内的关闭按钮
  const modalSelectors = [
    '[role="dialog"]', '[aria-modal="true"]',
    '.modal', '.dialog', '.drawer', '.popup', '.overlay',
    '[class*="modal"]', '[class*="Modal"]',
    '[class*="drawer"]', '[class*="Drawer"]',
    '[class*="overlay"]', '[class*="Overlay"]',
  ];
  for (const sel of modalSelectors) {
    const modals = document.querySelectorAll(sel);
    modals.forEach((modal) => {
      // 在弹窗内查找关闭按钮
      const closeBtns = (modal as HTMLElement).querySelectorAll(
        'button, [role="button"], a, span, div'
      );
      closeBtns.forEach((btn) => {
        const htmlBtn = btn as HTMLElement;
        const text = (htmlBtn.textContent || '').trim();
        const ariaLabel = (htmlBtn.getAttribute('aria-label') || '').trim();
        const title = (htmlBtn.getAttribute('title') || '').trim();
        const combined = `${text} ${ariaLabel} ${title}`.toLowerCase();
        for (const kw of MODAL_CLOSE_KEYWORDS) {
          if (combined.includes(kw.toLowerCase())) {
            const selector = getSelector(htmlBtn);
            if (!seen.has(selector)) {
              seen.add(selector);
              results.push({
                text: text || ariaLabel || title || kw,
                selector,
                tagName: htmlBtn.tagName.toLowerCase(),
              });
            }
            break;
          }
        }
      });
    });
  }

  // 2. 检测页面上可能触发弹窗的按钮（设置/编辑/配置等）
  const candidates = document.querySelectorAll('button, a, [role="button"], div, span');
  candidates.forEach((el) => {
    const htmlEl = el as HTMLElement;
    const text = (htmlEl.textContent || '').trim();
    const ariaLabel = (htmlEl.getAttribute('aria-label') || '').trim();
    const title = (htmlEl.getAttribute('title') || '').trim();
    const combined = `${text} ${ariaLabel} ${title}`.toLowerCase();
    // 仅匹配短文本按钮，避免误匹配大段文字
    if (text.length > 20) return;
    for (const kw of MODAL_TRIGGER_KEYWORDS) {
      if (combined.includes(kw.toLowerCase())) {
        const selector = getSelector(htmlEl);
        if (!seen.has(selector)) {
          seen.add(selector);
          results.push({
            text: text || ariaLabel || title || kw,
            selector,
            tagName: htmlEl.tagName.toLowerCase(),
          });
        }
        break;
      }
    }
  });

  // 3. 检测 Shadow DOM 中的弹窗触发按钮
  const allElements = document.querySelectorAll('*');
  allElements.forEach((el) => {
    const shadowRoot = (el as HTMLElement).shadowRoot;
    if (!shadowRoot) return;
    const shadowButtons = shadowRoot.querySelectorAll('button, [role="button"], a, span, div');
    shadowButtons.forEach((btn) => {
      const htmlBtn = btn as HTMLElement;
      const text = (htmlBtn.textContent || '').trim();
      if (text.length > 20) return;
      const ariaLabel = (htmlBtn.getAttribute('aria-label') || '').trim();
      const title = (htmlBtn.getAttribute('title') || '').trim();
      const combined = `${text} ${ariaLabel} ${title}`.toLowerCase();
      for (const kw of MODAL_TRIGGER_KEYWORDS) {
        if (combined.includes(kw.toLowerCase())) {
          // Shadow DOM 内元素需要特殊选择器，用最简路径
          const selector = getSelector(htmlBtn);
          if (!seen.has(selector)) {
            seen.add(selector);
            results.push({
              text: text || ariaLabel || title || kw,
              selector,
              tagName: htmlBtn.tagName.toLowerCase(),
            });
          }
          break;
        }
      }
    });
  });

  return results.slice(0, 20);
}

// ---------------------------------------------------------------------------
// 多层深度扫描策略
// ---------------------------------------------------------------------------

/**
 * 执行三级深度扫描：
 * - Level 1: 标准扫描（当前 scanPageForms，已含 Shadow DOM）
 * - Level 2: Shadow DOM 专项扫描（已在 scanPageForms 中集成，此处再次确认）
 * - Level 3: 等待 500ms 后重新扫描（捕获延迟渲染的元素）
 * 合并去重后返回。
 */
export function scanPageFormsDeep(): Promise<FormField[]> {
  return new Promise((resolve) => {
    // Level 1 & 2: 立即执行标准扫描（已包含 Shadow DOM 穿透）
    const level1 = scanPageForms();

    // Level 3: 等待 500ms 后重新扫描，捕获延迟渲染的元素
    setTimeout(() => {
      const level3 = scanPageForms();

      // 合并去重：以 selector 为唯一键
      const merged = new Map<string, FormField>();
      for (const field of level1) {
        merged.set(field.selector, field);
      }
      for (const field of level3) {
        if (!merged.has(field.selector)) {
          merged.set(field.selector, field);
        }
      }

      resolve(Array.from(merged.values()));
    }, 500);
  });
}

// ---------------------------------------------------------------------------
// Canvas Spreadsheet Detection & Support
// ---------------------------------------------------------------------------

import { CanvasSpreadsheetInfo, CanvasColumn } from './contentTypes';

/**
 * Detect if the current page uses a Canvas-based spreadsheet (e.g. SpreadJS,
 * Google Sheets Canvas mode, etc.). These render all data on <canvas> and
 * have little or no meaningful DOM for data cells.
 */
export function detectCanvasSpreadsheet(): CanvasSpreadsheetInfo {
  const canvasCount = document.querySelectorAll('canvas').length;
  const tables = document.querySelectorAll('table');
  const hasDomTable = tables.length > 0;

  // Heuristic: many canvases + few/no meaningful form fields = Canvas spreadsheet
  const isLikelyCanvasSheet = canvasCount >= 3;

  if (!isLikelyCanvasSheet) {
    return { detected: false, canvasCount, hasDomTable };
  }

  // Try to detect SpreadJS specifically
  let engine: CanvasSpreadsheetInfo['engine'] = 'canvas-generic';
  let apiAvailable = false;

  // Check for SpreadJS global API
  try {
    if ((window as any).GC && (window as any).GC.Spread && (window as any).GC.Spread.Sheets) {
      engine = 'spreadjs';
      apiAvailable = true;
    }
  } catch {}

  // Also check for common SpreadJS DOM markers
  const spreadjsMarkers = document.querySelectorAll('.gc-spread-sheets, [class*="spreadjs"], [class*="gc-spread"]');
  if (spreadjsMarkers.length > 0) {
    engine = 'spreadjs';
  }

  // Try to extract column headers from the first <table> (often used for headers in SpreadJS)
  const columns: CanvasColumn[] = [];
  if (hasDomTable && tables.length > 0) {
    // Find the table that has actual text content (not just buttons/toolbars)
    for (const table of tables) {
      const text = table.textContent?.trim() || '';
      if (text.length > 5 && text.length < 500) {
        // This might be a header table
        const rows = table.querySelectorAll('tr');
        for (const row of rows) {
          const cells = row.querySelectorAll('td, th');
          let colIndex = 0;
          for (const cell of cells) {
            const cellText = cell.textContent?.trim();
            if (cellText) {
              columns.push({ index: colIndex, label: cellText });
            }
            colIndex++;
          }
        }
        if (columns.length > 0) break;
      }
    }
  }

  // Check for iframe input (SpreadJS sometimes uses an iframe for cell editing)
  let iframeInputSelector: string | undefined;
  const iframes = document.querySelectorAll('iframe');
  for (const iframe of iframes) {
    try {
      const iframeDoc = (iframe as HTMLIFrameElement).contentDocument;
      if (iframeDoc) {
        const inputs = iframeDoc.querySelectorAll('input, textarea');
        if (inputs.length > 0) {
          iframeInputSelector = `iframe[src="${iframe.getAttribute('src')}"]`;
          break;
        }
      }
    } catch {}
  }

  return {
    detected: true,
    engine,
    canvasCount,
    hasDomTable,
    columns: columns.length > 0 ? columns : undefined,
    apiAvailable,
    iframeInputSelector,
  };
}

/**
 * Try to read column headers using the SpreadJS API if available.
 */
export function getSpreadJSColumns(): CanvasColumn[] | null {
  try {
    const GC = (window as any).GC;
    if (!GC || !GC.Spread || !GC.Spread.Sheets) return null;

    // Try to find the workbook instance
    const workbooks = document.querySelectorAll('.gc-spread-sheets, [class*="gc-spread"]');
    for (const wbEl of workbooks) {
      const spread = GC.Spread.Sheets.findControl(wbEl);
      if (spread) {
        const sheet = spread.getActiveSheet();
        const colCount = sheet.getColumnCount();
        const columns: CanvasColumn[] = [];
        for (let col = 0; col < colCount && col < 50; col++) {
          const value = sheet.getValue(0, col); // Header row is usually row 0
          if (value) {
            columns.push({ index: col, label: String(value) });
          }
        }
        return columns;
      }
    }
  } catch (err) {
    console.warn('SpreadJS API read failed:', err);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Content Script 消息监听：响应 background 转发的扫描请求
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(
  (message: { type: string; payload?: any }, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;

    if (message.type === 'EXEC_SCAN_DEEP') {
      // 同时执行深度扫描和弹窗检测
      const modals = detectModalOrDrawer();
      scanPageFormsDeep().then((fields) => {
        sendResponse({ fields, modals });
      });
      return true; // 异步响应
    }

    if (message.type === 'EXEC_DETECT_MODALS') {
      const modals = detectModalOrDrawer();
      sendResponse({ modals });
      return false;
    }

    return false;
  }
);
