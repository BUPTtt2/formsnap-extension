export type FieldType = 'text' | 'select' | 'radio' | 'checkbox' | 'date' | 'textarea' | 'number';

export interface ParsedField {
  field: string;
  value: string;
  type: FieldType;
  confidence?: number;
}

export interface FormField {
  selector: string;
  label: string;
  type: FieldType;
  name?: string;
  id?: string;
  placeholder?: string;
  tagName?: string;
  options?: string[];
  radioGroup?: string; // radio 按钮组名
  parentForm?: string; // 所属表单标识
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
  sourceField: ParsedField;
  targetField: FormField;
  confidence: number;
  status: 'auto' | 'confirm' | 'unmatched';
  userConfirmed?: boolean;
}

export interface ExtensionSettings {
  apiKey: string;
  apiEndpoint: string;     // OpenAI 兼容 API 端点
  apiModel: string;        // 文本模型
  apiVisionModel: string;  // 视觉模型（截图识别用）
  confidenceThreshold: number;
  confirmThreshold: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiKey: '',
  apiEndpoint: 'https://api.openai.com/v1/chat/completions',
  apiModel: 'gpt-4o',
  apiVisionModel: 'gpt-4o',
  confidenceThreshold: 0.95,
  confirmThreshold: 0.7,
};

// Chrome 消息类型
export type MessageType =
  | 'SCAN_FORM'
  | 'SCAN_FORM_RESULT'
  | 'PARSE_DATA_SOURCE'
  | 'PARSE_DATA_SOURCE_RESULT'
  | 'FILL_FORM'
  | 'FILL_FORM_RESULT'
  | 'FILL_CANVAS'
  | 'CAPTURE_TAB'
  | 'GET_SETTINGS'
  | 'GET_SETTINGS_RESULT'
  | 'SAVE_SETTINGS'
  | 'UNDO_FILL'
  | 'SAVE_MAPPING_HISTORY'
  | 'GET_MAPPING_HISTORY'
  | 'CLICK_NEW_BUTTON'
  | 'SCAN_FORM_DEEP'
  | 'DETECT_MODALS';

export interface ModalInfo {
  text: string;
  selector: string;
  tagName: string;
}

export interface FormSnapMessage {
  type: MessageType;
  payload?: any;
}

export interface ScanFormResult {
  fields: FormField[];
  url: string;
  title: string;
  newButtons?: NewButtonInfo[];
  canvasInfo?: CanvasSpreadsheetInfo;
}

export interface FillFormPayload {
  mappings: MappingResult[];
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

export interface MappingHistoryEntry {
  urlPattern: string;
  mappings: MappingResult[];
  timestamp: number;
}

export interface UndoRecord {
  selector: string;
  originalValue: string;
  originalChecked?: boolean;
  tagName: string;
}

export interface NewButtonInfo {
  text: string;
  selector: string;
  tagName: string;
}

export interface PopupState {
  step: 'input' | 'mapping' | 'filling' | 'done';
  inputMode: 'image' | 'text' | 'file';
  imagesBase64: string[];
  textContent: string;
  fileName: string | null;
  parsedFields: ParsedField[];
  parsedRows?: ParsedField[][]; // 多行数据（多张截图时每行一个记录）
  formFields: FormField[];
  mappings: MappingResult[];
  fillResult: { total: number; success: number; failed: number } | null;
  canUndo: boolean;
  canvasInfo?: CanvasSpreadsheetInfo;
  canvasColumns?: string;
  timestamp: number;
}
