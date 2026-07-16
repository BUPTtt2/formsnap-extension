import { FormField, MappingResult, FieldType, FillFormResult, FillFormResultItem } from './types';

function triggerEvents(el: HTMLElement): void {
  const eventTypes = ['input', 'change', 'blur'];
  eventTypes.forEach((type) => {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
  // For React 16+ synthetic events
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(el, (el as HTMLInputElement).value);
  }
  triggerEvents(el);
}

function fillTextInput(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLInputElement | HTMLTextAreaElement | null;
  if (!el) return false;

  if (el.tagName.toLowerCase() === 'textarea') {
    // React compatible setter for textarea
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else el.value = value;
  } else {
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (nativeSetter) nativeSetter.call(el, value);
    else (el as HTMLInputElement).value = value;
  }

  triggerEvents(el);
  // Also simulate keyboard input for frameworks that only listen to keydown
  el.focus();
  return true;
}

function fillSelect(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLSelectElement | null;
  if (!el || !field.options) return false;

  // Try to find matching option by text
  const options = Array.from(el.options);
  const targetOption = options.find((opt) => {
    const optText = opt.text.trim();
    return optText === value || optText.includes(value) || value.includes(optText);
  });

  if (targetOption) {
    el.value = targetOption.value;
    triggerEvents(el);
    return true;
  }

  return false;
}

function fillRadio(field: FormField, value: string): boolean {
  if (!field.radioGroup || !field.options) return false;

  const radios = document.querySelectorAll(`input[type="radio"][name="${CSS.escape(field.radioGroup)}"]`);
  const radiosArr = Array.from(radios) as HTMLInputElement[];

  for (const radio of radiosArr) {
    const label = getLabelForRadio(radio);
    if (label === value || label.includes(value) || value.includes(label) || radio.value === value) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      radio.dispatchEvent(new Event('click', { bubbles: true }));
      return true;
    }
  }

  return false;
}

function getLabelForRadio(radio: HTMLInputElement): string {
  if (radio.id) {
    const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (label) return label.textContent?.trim() || '';
  }
  const parentLabel = radio.closest('label');
  if (parentLabel) {
    const clone = parentLabel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('input').forEach((c) => c.remove());
    return clone.textContent?.trim() || '';
  }
  return radio.value;
}

function fillCheckbox(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLInputElement | null;
  if (!el) return false;

  const shouldCheck = value === 'true' || value === '1' || value === '是' || value === 'yes' || value.toLowerCase() === 'checked';
  el.checked = shouldCheck;
  triggerEvents(el);
  return true;
}

function fillDate(field: FormField, value: string): boolean {
  const el = document.querySelector(field.selector) as HTMLInputElement | null;
  if (!el) return false;

  // Try direct value set
  const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) nativeSetter.call(el, value);
  else el.value = value;
  triggerEvents(el);

  // Verify
  if (el.value === value) return true;

  // Fallback: try to parse and set in correct format
  try {
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      const iso = date.toISOString().split('T')[0];
      if (nativeSetter) nativeSetter.call(el, iso);
      else el.value = iso;
      triggerEvents(el);
      return el.value === iso;
    }
  } catch {}
  return false;
}

export function fillFormField(field: FormField, value: string): FillFormResultItem {
  try {
    let success = false;
    switch (field.type) {
      case 'textarea':
      case 'text':
      case 'number':
        success = fillTextInput(field, value);
        break;
      case 'select':
        success = fillSelect(field, value);
        break;
      case 'radio':
        success = fillRadio(field, value);
        break;
      case 'checkbox':
        success = fillCheckbox(field, value);
        break;
      case 'date':
        success = fillDate(field, value);
        break;
      default:
        success = fillTextInput(field, value);
    }
    return { selector: field.selector, success, error: success ? undefined : `Failed to fill ${field.type} field` };
  } catch (err: any) {
    return { selector: field.selector, success: false, error: err.message };
  }
}

export function executeFillMappings(mappings: MappingResult[]): FillFormResult {
  const items: FillFormResultItem[] = [];
  for (const mapping of mappings) {
    if (!mapping.userConfirmed || !mapping.targetField.selector) continue;
    const result = fillFormField(mapping.targetField, mapping.sourceField.value);
    items.push(result);
  }
  const success = items.filter((i) => i.success).length;
  return {
    items,
    total: items.length,
    success,
    failed: items.length - success,
  };
}
