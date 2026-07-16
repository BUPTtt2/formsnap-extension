import { FormField, MappingResult, FillFormResult, FillFormResultItem, UndoRecord } from './contentTypes';

function triggerEvents(el: HTMLElement): void {
  ['input', 'change', 'blur'].forEach((type) => {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
    'value'
  );
  if (descriptor?.set) {
    descriptor.set.call(el, value);
  } else {
    el.value = value;
  }
}

function fillTextInput(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return false;
  setNativeValue(el, value);
  el.focus();
  triggerEvents(el);
  return true;
}

function fillContentEditable(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLElement | null;
  if (!el) return false;
  el.focus();
  // Clear existing content
  el.textContent = value;
  // Trigger input event for frameworks (React, Vue, etc.)
  el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: value }));
  triggerEvents(el);
  // Also dispatch a clipboard paste event for spreadsheet apps that listen for it
  el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true }));
  return true;
}

function fillSelect(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLSelectElement | null;
  if (!el) return false;
  const targetOption = Array.from(el.options).find((opt) => {
    const t = opt.text.trim();
    return t === value || t.includes(value) || value.includes(t);
  });
  if (targetOption) {
    el.value = targetOption.value;
    triggerEvents(el);
    return true;
  }
  return false;
}

function fillRadio(field: FormField, value: string): boolean {
  if (!field.radioGroup) return false;
  const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(field.radioGroup)}"]`) as NodeListOf<HTMLInputElement>;
  for (const radio of radios) {
    let labelText = '';
    if (radio.id) {
      const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
      if (label) labelText = label.textContent?.trim() || '';
    }
    const parentLabel = radio.closest('label');
    if (parentLabel && !labelText) {
      const clone = parentLabel.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input').forEach((c) => c.remove());
      labelText = clone.textContent?.trim() || '';
    }
    if (labelText === value || labelText.includes(value) || value.includes(labelText) || radio.value === value) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      radio.dispatchEvent(new Event('click', { bubbles: true }));
      return true;
    }
  }
  return false;
}

function fillCheckbox(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLInputElement | null;
  if (!el) return false;
  el.checked = ['true', '1', '是', 'yes', 'checked'].includes(value.toLowerCase());
  triggerEvents(el);
  return true;
}

function fillDate(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLInputElement | null;
  if (!el) return false;
  setNativeValue(el, value);
  triggerEvents(el);
  if (el.value === value) return true;
  try {
    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      const iso = d.toISOString().split('T')[0];
      setNativeValue(el, iso);
      triggerEvents(el);
      return el.value === iso;
    }
  } catch {}
  return false;
}

export function fillFormField(field: FormField, value: string): FillFormResultItem {
  try {
    let success = false;
    // For contenteditable elements (online spreadsheets, rich text editors)
    if (field.tagName && field.tagName !== 'input' && field.tagName !== 'textarea' && field.tagName !== 'select') {
      const el = document.querySelector(field.selector) as HTMLElement | null;
      if (el && el.isContentEditable) {
        success = fillContentEditable(field, value);
        return { selector: field.selector, success, error: success ? undefined : `Failed to fill contenteditable` };
      }
    }
    switch (field.type) {
      case 'textarea': case 'text': case 'number':
        success = fillTextInput(field, value); break;
      case 'select':
        success = fillSelect(field, value); break;
      case 'radio':
        success = fillRadio(field, value); break;
      case 'checkbox':
        success = fillCheckbox(field, value); break;
      case 'date':
        success = fillDate(field, value); break;
      default:
        success = fillTextInput(field, value);
    }
    return { selector: field.selector, success, error: success ? undefined : `Failed to fill ${field.type}` };
  } catch (err: any) {
    return { selector: field.selector, success: false, error: err.message };
  }
}

export function executeFillMappings(mappings: MappingResult[]): FillFormResult {
  const items: FillFormResultItem[] = [];
  for (const mapping of mappings) {
    if (!mapping.userConfirmed || !mapping.targetField.selector) continue;
    items.push(fillFormField(mapping.targetField, mapping.sourceField.value));
  }
  const success = items.filter((i) => i.success).length;
  return { items, total: items.length, success, failed: items.length - success };
}

// Undo support: store original values before filling
const undoStack: UndoRecord[] = [];

export function executeFillMappingsWithUndo(mappings: MappingResult[]): FillFormResult {
  const items: FillFormResultItem[] = [];
  undoStack.length = 0; // Clear previous undo records

  for (const mapping of mappings) {
    if (!mapping.userConfirmed || !mapping.targetField.selector) continue;

    // Record original value before filling
    const el = document.querySelector(mapping.targetField.selector) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLElement | null;
    if (el) {
      if (el.isContentEditable) {
        undoStack.push({
          selector: mapping.targetField.selector,
          originalValue: el.textContent || '',
          tagName: el.tagName.toLowerCase(),
        });
      } else {
        undoStack.push({
          selector: mapping.targetField.selector,
          originalValue: (el as HTMLInputElement).value || '',
          originalChecked: (el as HTMLInputElement).checked,
          tagName: el.tagName.toLowerCase(),
        });
      }
    }

    items.push(fillFormField(mapping.targetField, mapping.sourceField.value));
  }

  const success = items.filter((i) => i.success).length;
  return { items, total: items.length, success, failed: items.length - success };
}

export function undoFill(): { total: number; success: number } {
  let success = 0;
  for (const record of undoStack) {
    const el = document.querySelector(record.selector) as HTMLElement | null;
    if (!el) continue;
    try {
      if (el.isContentEditable) {
        // Restore contenteditable text content
        el.focus();
        el.textContent = record.originalValue;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText' }));
        ['input', 'change', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
        success++;
      } else if (record.tagName === 'select') {
        const select = document.querySelector(record.selector) as HTMLSelectElement;
        if (select) {
          const option = Array.from(select.options).find((o) => o.value === record.originalValue);
          if (option) select.value = option.value;
        }
        success++;
      } else if (record.originalChecked !== undefined) {
        (el as HTMLInputElement).checked = record.originalChecked;
        success++;
      } else {
        const setter = Object.getOwnPropertyDescriptor(
          record.tagName === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
          'value'
        );
        if (setter && setter.set) setter.set.call(el, record.originalValue);
        else (el as HTMLInputElement).value = record.originalValue;
        ['input', 'change', 'blur'].forEach((t) => el.dispatchEvent(new Event(t, { bubbles: true })));
        success++;
      }
    } catch {}
  }
  return { total: undoStack.length, success };
}

// ---------------------------------------------------------------------------
// Canvas Spreadsheet Fill Support
// ---------------------------------------------------------------------------

import { FillCanvasPayload } from './contentTypes';

/**
 * Fill a Canvas-based spreadsheet (e.g. SpreadJS).
 *
 * Strategy (in order):
 * 1. SpreadJS API: sheet.setValue(row, col, value) — most reliable
 * 2. SpreadJS event: findControl → setActiveCell → startEdit → setValue → stopEdit
 * 3. Clipboard: copy value to clipboard, simulate Ctrl+V paste
 */
export function fillCanvasSpreadsheet(payload: FillCanvasPayload): FillFormResult {
  const items: FillFormResultItem[] = [];

  // Try SpreadJS API (most reliable)
  const apiResult = trySpreadJSApiFill(payload);
  if (apiResult) return apiResult;

  // Fallback: clipboard paste simulation
  for (const mapping of payload.mappings) {
    if (!mapping.userConfirmed) continue;
    const value = mapping.sourceField.value;
    const colLabel = mapping.targetField.label;

    try {
      // Try clipboard paste
      const success = pasteViaClipboard(value);
      items.push({ selector: colLabel, success, error: success ? undefined : 'Paste failed' });

      // Move to next cell (Tab key)
      setTimeout(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
        document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', keyCode: 9, bubbles: true, cancelable: true }));
      }, 200);
    } catch (err: any) {
      items.push({ selector: colLabel, success: false, error: err.message });
    }
  }

  const success = items.filter((i) => i.success).length;
  return { items, total: items.length, success, failed: items.length - success };
}

/**
 * Use the Clipboard API to paste a value into the active cell.
 * Works with most spreadsheet editors that listen for paste events.
 */
function pasteViaClipboard(value: string): boolean {
  try {
    // Simulate Ctrl+V paste event
    const target = document.activeElement || document.body;
    const dt = new DataTransfer();
    dt.setData('text/plain', value);
    target.dispatchEvent(new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dt,
    }));
    // Also try execCommand as fallback
    document.execCommand('insertText', false, value);
    return true;
  } catch {
    try {
      document.execCommand('insertText', false, value);
      return true;
    } catch {
      return false;
    }
  }
}

function trySpreadJSApiFill(payload: FillCanvasPayload): FillFormResult | null {
  try {
    const GC = (window as any).GC;
    if (!GC || !GC.Spread || !GC.Spread.Sheets) return null;

    // Try to find workbook instances in multiple ways
    const selectors = [
      '.gc-spread-sheets',
      '[class*="gc-spread"]',
      '.spread-container',
      '[id*="spread"]',
      '[id*="sheet"]',
    ];

    for (const sel of selectors) {
      const wbEls = document.querySelectorAll(sel);
      for (const wbEl of wbEls) {
        let spread = null;
        try {
          spread = GC.Spread.Sheets.findControl(wbEl);
        } catch {}
        if (!spread) continue;

        const sheet = spread.getActiveSheet();
        if (!sheet) continue;

        const items: FillFormResultItem[] = [];

        // Find current active cell
        const selections = sheet.getSelections();
        const startRow = selections?.[0]?.row ?? 1; // Row 0 is often header
        let filledCount = 0;

        for (const mapping of payload.mappings) {
          if (!mapping.userConfirmed) continue;

          try {
            const colLabel = mapping.targetField.label;
            let targetCol = -1;

            // Find column index by header label
            const colCount = sheet.getColumnCount();
            for (let col = 0; col < Math.min(colCount, 100); col++) {
              const headerValue = sheet.getValue(0, col);
              if (headerValue && String(headerValue).trim().toLowerCase().replace(/[\s\-_]/g, '') ===
                  colLabel.toLowerCase().replace(/[\s\-_]/g, '')) {
                targetCol = col;
                break;
              }
            }

            if (targetCol >= 0) {
              sheet.setValue(startRow, targetCol, mapping.sourceField.value);
              items.push({ selector: colLabel, success: true });
              filledCount++;
            } else {
              items.push({ selector: colLabel, success: false, error: `Column "${colLabel}" not found in header row` });
            }
          } catch (err: any) {
            items.push({ selector: mapping.targetField.label, success: false, error: err.message });
          }
        }

        if (filledCount > 0) {
          // Commit changes
          try { spread.repaint(); } catch {}
        }

        const success = items.filter((i) => i.success).length;
        return { items, total: items.length, success, failed: items.length - success };
      }
    }

    // Also try findControl with any element
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      try {
        const spread = GC.Spread.Sheets.findControl(el);
        if (spread) {
          // Found it! But we already tried the obvious selectors above,
          // this is a last resort
          return null;
        }
      } catch {}
    }
  } catch (err) {
    console.warn('[FormSnap] SpreadJS API fill attempt failed:', err);
  }
  return null;
}
