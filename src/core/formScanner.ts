import { FormField, FieldType } from './types';

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
    if (type === 'file' || type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset') return 'text'; // skip these
    return 'text';
  }
  return 'text';
}

function getLabelForElement(el: HTMLElement): string {
  // 1. Check associated <label> via `for` attribute
  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label) return label.textContent?.trim() || '';
  }

  // 2. Check parent <label>
  const parentLabel = el.closest('label');
  if (parentLabel) {
    // Get text excluding nested inputs
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input,select,textarea').forEach((c) => c.remove());
    const text = clone.textContent?.trim();
    if (text) return text;
  }

  // 3. Check aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  // 4. Check aria-labelledby
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const refEl = document.getElementById(labelledBy);
    if (refEl) return refEl.textContent?.trim() || '';
  }

  // 5. Check placeholder
  const placeholder = (el as HTMLInputElement).placeholder;
  if (placeholder) return placeholder.trim();

  // 6. Check preceding sibling text
  const prev = el.previousElementSibling;
  if (prev && prev.tagName !== 'BR') {
    const text = prev.textContent?.trim();
    if (text && text.length < 50) return text;
  }

  // 7. Check name attribute as fallback
  const name = (el as HTMLInputElement).name;
  if (name) return name.replace(/[_-]/g, ' ');

  return '';
}

function getSelector(el: HTMLElement): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  if ((el as any).name) return `${el.tagName.toLowerCase()}[name="${CSS.escape((el as any).name)}"]`;

  // Build path
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

export function scanPageForms(): FormField[] {
  const fields: FormField[] = [];
  const seenSelectors = new Set<string>();

  // Scan all form elements
  const inputs = document.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]):not([type="file"]), select, textarea');

  const processedRadioGroups = new Set<string>();

  inputs.forEach((el) => {
    const htmlEl = el as HTMLElement;
    const type = detectFieldType(htmlEl);
    const label = getLabelForElement(htmlEl);

    // For radio, only process once per group
    if (type === 'radio') {
      const name = (el as HTMLInputElement).name;
      if (!name || processedRadioGroups.has(name)) return;
      processedRadioGroups.add(name);
      const selector = `input[type="radio"][name="${CSS.escape(name)}"]`;
      if (seenSelectors.has(selector)) return;
      seenSelectors.add(selector);

      fields.push({
        selector,
        label,
        type: 'radio',
        name,
        options: getRadioGroupOptions(name),
        radioGroup: name,
      });
      return;
    }

    const selector = getSelector(htmlEl);
    if (seenSelectors.has(selector)) return;
    seenSelectors.add(selector);

    const field: FormField = {
      selector,
      label,
      type,
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

  return fields;
}
