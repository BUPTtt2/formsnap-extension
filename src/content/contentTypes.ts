// Content script has its own type definitions to avoid webpack shared chunks.
// Chrome extension content scripts cannot load additional JS chunks at runtime.

export interface FormField {
  selector: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'date' | 'number';
  name?: string;
  id?: string;
  placeholder?: string;
  options?: string[] | { label: string; value: string }[];
  tagName?: string;
  radioGroup?: string;
}

export interface CanvasColumn {
  index: number;
  label: string;
}

export interface CanvasSpreadsheetInfo {
  detected: boolean;
  engine?: 'spreadjs' | 'canvas-generic' | 'unknown';
  canvasCount: number;
  hasDomTable: boolean;
  columns?: CanvasColumn[];
  apiAvailable?: boolean;
  iframeInputSelector?: string;
}

export interface MappingResult {
  sourceField: { field: string; value: string; type: string };
  targetField: FormField;
  confidence: number;
  status: 'auto' | 'confirm' | 'unmatched';
  userConfirmed: boolean;
}

export interface NewButtonInfo {
  text: string;
  selector: string;
  tagName: string;
}

export interface ModalInfo {
  text: string;
  selector: string;
  tagName: string;
}

export interface FillFormResultItem {
  selector: string;
  success: boolean;
  error?: string;
}

export interface FillFormResult {
  items: FillFormResultItem[];
  total: number;
  success: number;
  failed: number;
}

export interface UndoRecord {
  selector: string;
  originalValue: string;
  originalChecked?: boolean;
  tagName: string;
}

export interface FillCanvasPayload {
  mappings: MappingResult[];
  startColumnIndex: number;
}

export type FormSnapMessage = {
  type: string;
  payload?: any;
};
