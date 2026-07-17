import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ParsedField, FormField, MappingResult, ExtensionSettings, NewButtonInfo, CanvasSpreadsheetInfo, CanvasColumn, ModalInfo, FieldType } from '../core/types';
import { sendMessage, sendMessageToTab, getCurrentTab } from '../utils/message';
import { prepareImageForAI, clipboardToBlob } from '../utils/imageUtils';
import { parseFile } from '../utils/fileParser';
import { savePopupState, getPopupState, clearPopupState } from '../utils/storage';

type AppStep = 'input' | 'data-review' | 'mapping' | 'filling' | 'done';
type InputMode = 'image' | 'text' | 'file';

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE_MB = 5;
const MAX_FILE_SIZE_MB = 10;

export default function Popup() {
  const [step, setStep] = useState<AppStep>('input');
  const [inputMode, setInputMode] = useState<InputMode>('image');
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [imagesBase64, setImagesBase64] = useState<string[]>([]);
  const [targetImages, setTargetImages] = useState<string[]>([]);
  const [targetPreviews, setTargetPreviews] = useState<string[]>([]);
  const [textContent, setTextContent] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<{ key: string; data: any; label: string; timestamp: number; type: string }[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileData, setFileData] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<{ type: 'loading' | 'success' | 'error' | 'info'; text: string } | null>(null);
  const [parsedFields, setParsedFields] = useState<ParsedField[]>([]);
  const [formFields, setFormFields] = useState<FormField[]>([]);
  const [mappings, setMappings] = useState<MappingResult[]>([]);
  const [fillResult, setFillResult] = useState<{ total: number; success: number; failed: number } | null>(null);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [apiKeyMissing, setApiKeyMissing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [newButtons, setNewButtons] = useState<NewButtonInfo[] | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [canvasInfo, setCanvasInfo] = useState<CanvasSpreadsheetInfo | null>(null);
  const [canvasColumns, setCanvasColumns] = useState<string>('');
  const [scanningColumns, setScanningColumns] = useState(false);
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);
  const [parsedRows, setParsedRows] = useState<ParsedField[][]>([]);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [manualField, setManualField] = useState('');
  const [manualValue, setManualValue] = useState('');
  const [manualTargetIdx, setManualTargetIdx] = useState(-1);
  const [modalButtons, setModalButtons] = useState<ModalInfo[] | null>(null);
  const [scanDepth, setScanDepth] = useState<'standard' | 'deep'>('standard');
  const [pageMode, setPageMode] = useState<string>('standard');
  const [tableModalData, setTableModalData] = useState<{ headers: string[]; rows: any[]; modalSelector: string } | null>(null);
  const [agentProgress, setAgentProgress] = useState<{ current: number; total: number } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const excelFileRef = useRef<HTMLInputElement>(null);
  const targetFileInputRef = useRef<HTMLInputElement>(null);

  // Load settings
  useEffect(() => {
    sendMessage<ExtensionSettings>('GET_SETTINGS').then((s) => {
      setSettings(s);
      if (!s?.apiKey) setApiKeyMissing(true);
    }).catch(() => {});
  }, []);

  // Restore popup state on mount
  useEffect(() => {
    getPopupState().then((state) => {
      if (state) {
        setStep(state.step);
        setInputMode(state.inputMode);
        setImagesBase64(state.imagesBase64);
        // Re-create blob URLs for previews from base64
        if (state.imagesBase64.length > 0) {
          const previews = state.imagesBase64.map((b64) => {
            try {
              const byteString = atob(b64.split(',')[1]);
              const mime = b64.split(',')[0].split(':')[1].split(';')[0];
              const ab = new ArrayBuffer(byteString.length);
              const ia = new Uint8Array(ab);
              for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
              const blob = new Blob([ab], { type: mime });
              return URL.createObjectURL(blob);
            } catch {
              return '';
            }
          }).filter(Boolean);
          setImagePreviews(previews);
        }
        setTextContent(state.textContent);
        setFileName(state.fileName);
        setParsedFields(state.parsedFields);
        if (state.parsedRows) setParsedRows(state.parsedRows);
        setFormFields(state.formFields);
        setMappings(state.mappings);
        setFillResult(state.fillResult);
        setCanUndo(state.canUndo);
        if (state.canvasInfo) setCanvasInfo(state.canvasInfo);
        if (state.canvasColumns) setCanvasColumns(state.canvasColumns);
      }
      // Check for pending reuse mappings from Options page
      chrome.storage.local.get(['pending_reuse_mappings'], (res) => {
        if (res.pending_reuse_mappings?.length) {
          const reused = (res.pending_reuse_mappings as MappingResult[]).map((m) => ({ ...m, userConfirmed: true }));
          setMappings(reused);
          chrome.storage.local.remove(['pending_reuse_mappings']);
          // If we have form fields from restore, jump to mapping step
          if (state?.formFields?.length || state?.canvasInfo?.detected) {
            setStep('mapping');
          }
        }
      });
      setRestoring(false);
    }).catch(() => setRestoring(false));
  }, []);

  // Save popup state on key changes
  useEffect(() => {
    if (restoring) return;
    const state = {
      step,
      inputMode,
      imagesBase64,
      textContent,
      fileName,
      parsedFields,
      formFields,
      mappings,
      fillResult,
      canUndo,
      canvasInfo: canvasInfo || undefined,
      canvasColumns,
      timestamp: Date.now(),
    };
    savePopupState(state as any).catch(() => {});
  }, [step, inputMode, imagesBase64, textContent, fileName, parsedFields, parsedRows, formFields, mappings, fillResult, canUndo, canvasInfo, canvasColumns, restoring]);

  const handleImageFile = useCallback(async (file: File) => {
    if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) {
      setStatus({ type: 'error', text: `图片超过 ${MAX_IMAGE_SIZE_MB}MB 限制，请压缩后重试` });
      setTimeout(() => setStatus(null), 3000);
      return;
    }
    if (imagesBase64.length >= MAX_IMAGES) {
      setStatus({ type: 'error', text: `最多支持 ${MAX_IMAGES} 张截图` });
      setTimeout(() => setStatus(null), 3000);
      return;
    }
    const preview = URL.createObjectURL(file);
    setImagePreviews((prev) => [...prev, preview]);
    try {
      const b64 = await prepareImageForAI(file);
      setImagesBase64((prev) => [...prev, b64]);
    } catch (err: any) {
      setStatus({ type: 'error', text: '图片处理失败: ' + err.message });
      setTimeout(() => setStatus(null), 3000);
    }
  }, [imagesBase64.length]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    if (inputMode === 'image') {
      const blob = clipboardToBlob(e.clipboardData);
      if (blob) handleImageFile(blob);
    }
  }, [inputMode, handleImageFile]);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && inputMode === 'image') {
      Array.from(files).forEach((f) => handleImageFile(f));
    } else if (files?.[0] && inputMode === 'file') {
      const f = files[0];
      if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
        setStatus({ type: 'error', text: `文件超过 ${MAX_FILE_SIZE_MB}MB 限制` });
        setTimeout(() => setStatus(null), 3000);
        return;
      }
      setFileName(f.name);
      setFileData(f);
    }
  }, [inputMode, handleImageFile]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const files = e.dataTransfer.files;
    if (!files || !files.length) return;
    if (inputMode === 'image') {
      Array.from(files).filter((f) => f.type.startsWith('image/')).forEach((f) => handleImageFile(f));
    } else if (inputMode === 'file') {
      const f = Array.from(files)[0];
      if (f) {
        if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
          setStatus({ type: 'error', text: `文件超过 ${MAX_FILE_SIZE_MB}MB 限制` });
          setTimeout(() => setStatus(null), 3000);
          return;
        }
        setFileName(f.name);
        setFileData(f);
      }
    }
  }, [inputMode, handleImageFile]);

  // Step 1: Parse data only — no page scanning
  const handleTargetImage = useCallback(async (file: File) => {
    if (file.size > MAX_IMAGE_SIZE_MB * 1024 * 1024) return;
    if (targetImages.length >= 3) return; // max 3 target screenshots
    const preview = URL.createObjectURL(file);
    setTargetPreviews((prev) => [...prev, preview]);
    try {
      const b64 = await prepareImageForAI(file);
      setTargetImages((prev) => [...prev, b64]);
    } catch {}
  }, [targetImages.length]);

  const handleParseData = useCallback(async () => {
    setLoading(true);
    setNewButtons(null);
    setStatus({ type: 'loading', text: '正在解析数据...' });

    try {
      let fields: ParsedField[] = [];

      // Pure text: try local parsing first (no API needed)
      if (inputMode === 'text' && textContent.trim()) {
        const { parseTextLocal } = await import('../utils/textParser');
        const localFields = parseTextLocal(textContent);
        if (localFields && localFields.length > 0) {
          fields = localFields;
        }
      }

      // Parse data source (AI needed for images or when local parsing fails)
      if (inputMode === 'file' && fileData) {
        fields = await parseFile(fileData);
        if (!fields.length) throw new Error('文件中未识别到有效数据');
      } else if (!fields.length && (imagesBase64.length > 0 || (inputMode === 'text' && textContent.trim()))) {
        if (imagesBase64.length > 1) {
          const multiRows: ParsedField[][] = [];
          for (let i = 0; i < imagesBase64.length; i++) {
            setStatus({ type: 'loading', text: `正在解析第 ${i + 1}/${imagesBase64.length} 张截图...` });
            const parseResult = await sendMessage<{ fields: ParsedField[]; error?: string }>('PARSE_DATA_SOURCE', {
              images: [imagesBase64[i]],
            });
            if (parseResult.error) throw new Error(parseResult.error);
            if (parseResult.fields?.length) multiRows.push(parseResult.fields);
          }
          if (multiRows.length === 0) throw new Error('未能从截图中识别到任何字段');
          setParsedRows(multiRows);
          fields = multiRows[0];
        } else {
          const parseResult = await sendMessage<{ fields: ParsedField[]; error?: string }>('PARSE_DATA_SOURCE', {
            images: imagesBase64.length > 0 ? imagesBase64 : undefined,
            text: textContent.trim() || undefined,
          });
          if (parseResult.error) throw new Error(parseResult.error);
          if (!parseResult.fields?.length) throw new Error('未能从数据源中识别到任何字段');
          fields = parseResult.fields;
        }
      } else if (!fields.length) {
        throw new Error('请提供数据');
      }

      setParsedFields(fields);
      setStatus({ type: 'success', text: `已识别 ${fields.length} 个字段，请确认数据后点击"扫描页面并填写"` });
      setStep('data-review');
      setLoading(false);
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '处理失败' });
      setLoading(false);
    }
  }, [imagesBase64, textContent, inputMode, fileData]);

  // Step 2: Scan page + match + fill (triggered from data-review or mapping)
  const handleScanAndFill = useCallback(async () => {
    setLoading(true);
    setModalButtons(null);
    setScanDepth('standard');
    setStatus({ type: 'loading', text: '正在扫描页面表单...' });

    try {
      const tab = await getCurrentTab();
      let scanResult: { fields: FormField[]; newButtons?: NewButtonInfo[]; canvasInfo?: CanvasSpreadsheetInfo; url: string; title: string };
      try {
        scanResult = await sendMessageToTab<{ fields: FormField[]; newButtons?: NewButtonInfo[]; canvasInfo?: CanvasSpreadsheetInfo; url: string; title: string }>(
          tab.id!, 'SCAN_FORM'
        );
      } catch (scanErr: any) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            files: ['content.js'],
          });
          await new Promise((r) => setTimeout(r, 500));
          scanResult = await sendMessageToTab<{ fields: FormField[]; newButtons?: NewButtonInfo[]; canvasInfo?: CanvasSpreadsheetInfo; url: string; title: string }>(
            tab.id!, 'SCAN_FORM'
          );
        } catch (injectErr: any) {
          setStatus({ type: 'error', text: '无法连接到当前页面。请刷新页面后重试。' });
          setLoading(false);
          return;
        }
      }

      if (scanResult.canvasInfo) {
        setCanvasInfo(scanResult.canvasInfo);
      }

      if (!scanResult?.fields?.length) {
        if (scanResult.canvasInfo?.detected) {
          setStatus({ type: 'info', text: '检测到 Canvas 表格，需要手动指定列名' });
          setStep('mapping');
          setLoading(false);
          return;
        }
        setStatus({ type: 'loading', text: '标准扫描未找到表单，尝试深度扫描...' });
        setScanDepth('deep');
        try {
          const deepResult = await sendMessage<{ fields?: FormField[]; modals?: ModalInfo[]; error?: string }>('SCAN_FORM_DEEP');
          if (deepResult.fields?.length) {
            scanResult = { ...scanResult, fields: deepResult.fields };
          }
          if (deepResult.modals?.length) {
            setModalButtons(deepResult.modals);
          }
        } catch (deepErr) {}

        if (!scanResult.fields?.length) {
          setStatus({ type: 'loading', text: '尝试检测表格型弹窗...' });
          try {
            const tableModalResult = await sendMessage<{ detected: boolean; rows?: any[]; headers?: string[]; modalSelector?: string; error?: string }>(
              'SCAN_TABLE_MODAL'
            );
            if (tableModalResult?.detected && tableModalResult.headers?.length) {
              const tableFields: FormField[] = [];
              const headers = tableModalResult.headers;
              const rows = tableModalResult.rows || [];
              const isEmptyTable = rows.length === 0;
              for (let colIdx = 0; colIdx < headers.length; colIdx++) {
                const headerName = headers[colIdx];
                let selector = '';
                let cellType = 'text';
                for (const row of rows) {
                  const cell = row.cells?.find((c: any) => c.colIndex === colIdx);
                  if (cell?.element) {
                    selector = cell.selector;
                    cellType = cell.type || 'text';
                    break;
                  }
                }
                if (selector) {
                  const fieldType: FieldType = cellType === 'toggle' ? 'checkbox' : cellType === 'select' ? 'select' : cellType === 'textarea' ? 'textarea' : 'text';
                  tableFields.push({ label: headerName, selector, type: fieldType });
                } else if (isEmptyTable && headerName) {
                  tableFields.push({ label: headerName, selector: '__needs_new_row__', type: 'text' });
                }
              }
              if (tableFields.length > 0) {
                scanResult = { ...scanResult, fields: tableFields };
                setPageMode('table-modal');
                setTableModalData({ headers: tableModalResult.headers, rows: tableModalResult.rows || [], modalSelector: tableModalResult.modalSelector || '' });
              }
            }
          } catch (tableErr) {}

          if (!scanResult.fields?.length) {
            if (scanResult.newButtons && scanResult.newButtons.length > 0) {
              setNewButtons(scanResult.newButtons);
              setStatus({ type: 'info', text: `检测到 ${scanResult.newButtons.length} 个"新建"按钮` });
            } else if (modalButtons && modalButtons.length > 0) {
              setStatus({ type: 'info', text: `检测到 ${modalButtons.length} 个弹窗按钮，请先点击打开` });
            } else {
              setStatus({ type: 'error', text: '当前页面未检测到表单字段' });
            }
            setLoading(false);
            return;
          }
        }
      }

      await proceedWithScanResult(parsedFields, scanResult);
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '扫描失败' });
      setLoading(false);
    }
  }, [parsedFields]);

  const proceedWithScanResult = async (
    sourceFields: ParsedField[],
    scanResult: { fields: FormField[]; url: string; title: string }
  ) => {
    setFormFields(scanResult.fields);
    setNewButtons(null);
    setStatus({ type: 'loading', text: `检测到 ${scanResult.fields.length} 个表单字段，正在匹配...` });

    let matched = clientSideMatch(sourceFields, scanResult.fields);
    try {
      const history = await sendMessage<{ mappings: MappingResult[] } | null>('GET_MAPPING_HISTORY', {
        urlPattern: scanResult.url,
      });
      if (history?.mappings) {
        matched = matched.map((m) => {
          const prevMapping = history.mappings.find((hm) =>
            hm.sourceField.field === m.sourceField.field
          );
          if (prevMapping?.targetField?.selector) {
            const existingTarget = scanResult.fields.find(
              (f) => f.selector === prevMapping.targetField.selector
            );
            if (existingTarget) {
              return {
                ...m,
                targetField: existingTarget,
                confidence: Math.max(m.confidence, 0.95),
                status: 'auto' as const,
                userConfirmed: true,
              };
            }
          }
          return m;
        });
      }
    } catch {}

    setMappings(matched);
    setStep('mapping');
    setLoading(false);
    setStatus(null);
  };

  const handleClickNewButton = useCallback(async (selector: string) => {
    setLoading(true);
    setStatus({ type: 'loading', text: '正在点击新建按钮并等待表单加载...' });
    try {
      const tab = await getCurrentTab();
      const result = await sendMessageToTab<{ success: boolean; fields?: FormField[]; newButtons?: NewButtonInfo[]; error?: string; url: string; title: string }>(
        tab.id!, 'CLICK_NEW_BUTTON', { selector }
      );
      if (!result.success) {
        setStatus({ type: 'error', text: '点击新建按钮失败: ' + (result.error || '未知错误') });
        setLoading(false);
        return;
      }
      if (!result.fields || result.fields.length === 0) {
        if (result.newButtons && result.newButtons.length > 0) {
          setNewButtons(result.newButtons);
          setStatus({ type: 'info', text: '仍未检测到表单字段，可能需要再次点击其他新建按钮' });
        } else {
          setStatus({ type: 'error', text: '点击后仍未检测到表单字段，请手动操作后重试' });
        }
        setLoading(false);
        return;
      }
      await proceedWithScanResult(parsedFields, {
        fields: result.fields,
        url: result.url,
        title: result.title,
      });
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '操作失败' });
      setLoading(false);
    }
  }, [parsedFields]);

  // 点击弹窗/设置按钮，然后重新扫描
  const handleClickModalButton = useCallback(async (selector: string) => {
    setLoading(true);
    setStatus({ type: 'loading', text: '正在打开弹窗并重新扫描...' });
    try {
      const tab = await getCurrentTab();
      // 点击弹窗按钮
      await sendMessageToTab(tab.id!, 'CLICK_NEW_BUTTON', { selector });
      // 等待弹窗动画完成
      await new Promise((r) => setTimeout(r, 800));
      // 深度扫描
      const deepResult = await sendMessage<{ fields?: FormField[]; modals?: ModalInfo[]; error?: string }>('SCAN_FORM_DEEP');
      if (deepResult.fields?.length) {
        await proceedWithScanResult(parsedFields, {
          fields: deepResult.fields,
          url: (await getCurrentTab()).url || '',
          title: '',
        });
      } else {
        setStatus({ type: 'info', text: '弹窗打开后仍未检测到表单，请手动展开编辑区域后重试' });
        setLoading(false);
      }
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '操作失败' });
      setLoading(false);
    }
  }, [parsedFields]);

  const clientSideMatch = (source: ParsedField[], target: FormField[]): MappingResult[] => {
    const results: MappingResult[] = [];
    const usedTargets = new Set<string>();
    for (const src of source) {
      let bestMatch: FormField | null = null;
      let bestConf = 0;
      for (const tgt of target) {
        if (usedTargets.has(tgt.selector)) continue;
        const srcNorm = src.field.toLowerCase().replace(/[\s\-_]/g, '');
        const tgtNorm = tgt.label.toLowerCase().replace(/[\s\-_]/g, '');
        const tgtNameNorm = (tgt.name || '').toLowerCase().replace(/[\s\-_]/g, '');
        const tgtPlaceholderNorm = (tgt.placeholder || '').toLowerCase().replace(/[\s\-_]/g, '');
        const tgtIdNorm = (tgt.id || '').toLowerCase().replace(/[\s\-_]/g, '');
        if (srcNorm === tgtNorm || srcNorm === tgtNameNorm || srcNorm === tgtPlaceholderNorm || srcNorm === tgtIdNorm) {
          bestMatch = tgt; bestConf = 1.0; break;
        }
      }
      if (!bestMatch) {
        for (const tgt of target) {
          if (usedTargets.has(tgt.selector)) continue;
          const sim = Math.max(
            bigramSimilarity(src.field, tgt.label),
            bigramSimilarity(src.field, tgt.name || ''),
            bigramSimilarity(src.field, tgt.placeholder || ''),
            bigramSimilarity(src.field, tgt.id || ''),
            bigramSimilarity(src.value, tgt.label),
            bigramSimilarity(src.value, tgt.name || ''),
          );
          if (sim > bestConf) { bestConf = sim; bestMatch = tgt; }
        }
      }
      if (bestMatch) {
        usedTargets.add(bestMatch.selector);
        const status: MappingResult['status'] = bestConf >= 0.95 ? 'auto' : bestConf >= 0.7 ? 'confirm' : 'unmatched';
        results.push({ sourceField: src, targetField: bestMatch, confidence: Math.round(bestConf * 100) / 100, status, userConfirmed: status === 'auto' });
      } else {
        results.push({ sourceField: src, targetField: { selector: '', label: '(未匹配)', type: src.type }, confidence: 0, status: 'unmatched', userConfirmed: false });
      }
    }
    return results;
  };

  const toggleMapping = (index: number) => {
    setMappings((prev) => prev.map((m, i) => (i === index ? { ...m, userConfirmed: !m.userConfirmed } : m)));
  };

  const selectTarget = (index: number, selector: string) => {
    const target = formFields.find((f) => f.selector === selector);
    if (!target) return;
    setMappings((prev) => prev.map((m, i) => i === index ? { ...m, targetField: target, confidence: 0.8, status: 'confirm' as const, userConfirmed: true } : m));
  };

  const applyCanvasColumns = useCallback(() => {
    if (!canvasColumns.trim()) return;
    const cols = canvasColumns.split(/[,，;；]/).map((c) => c.trim()).filter(Boolean);
    const virtualFields: FormField[] = cols.map((label, i) => ({
      selector: `__canvas_col_${i}__`,
      label,
      type: 'text' as const,
    }));
    setFormFields(virtualFields);
    const matched = clientSideMatch(parsedFields, virtualFields);
    // For Canvas mode, auto-confirm all matched fields
    const autoConfirmed = matched.map((m) => ({
      ...m,
      userConfirmed: !!m.targetField.selector,
    }));
    setMappings(autoConfirmed);
  }, [canvasColumns, parsedFields]);

  // Scan target table columns from a screenshot using AI vision
  const scanColumnsFromImage = useCallback(async () => {
    if (!settings?.apiKey) {
      setStatus({ type: 'error', text: '请先在设置中配置 API Key' });
      return;
    }
    setStatus({ type: 'loading', text: '正在识别表格列名...' });
    setScanningColumns(true);

    try {
      // Capture current tab screenshot via background
      let dataUrl: string;
      try {
        const captureResult = await sendMessage<{ dataUrl?: string; error?: string }>('CAPTURE_TAB');
        if (captureResult.error) throw new Error(captureResult.error);
        if (!captureResult.dataUrl) throw new Error('截图失败');
        dataUrl = captureResult.dataUrl;
      } catch (captureErr: any) {
        throw new Error('截图失败：' + (captureErr.message || '请确保有活跃的标签页'));
      }

      // Use vision model to extract column names
      const endpoint = settings.apiEndpoint;
      const apiKey = settings.apiKey;
      const model = settings.apiVisionModel || settings.apiModel;

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content: '你是一个表格列名识别助手。只返回 JSON 数组，不要其他文字。',
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: '请识别这个表格的所有列名（表头）。只返回 JSON 字符串数组格式，例如 ["姓名","年龄","成绩"]。只返回可见的列名，不要包含行号列（如 A、B、C）。',
                },
                {
                  type: 'image_url',
                  image_url: { url: dataUrl },
                },
              ],
            },
          ],
          max_tokens: 512,
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`列名识别失败 (${response.status})`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('AI 未返回列名');

      // Parse column names from AI response
      const cols = parseColumnNames(content);
      if (cols.length === 0) throw new Error('未能识别到列名，请手动输入');

      // Auto-fill the column input
      setCanvasColumns(cols.join(', '));
      setStatus({ type: 'success', text: `识别到 ${cols.length} 个列名，已自动填入` });
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '列名识别失败' });
    } finally {
      setScanningColumns(false);
    }
  }, [settings]);

  // Parse column names from AI response (may be JSON array or comma-separated text)
  function parseColumnNames(content: string): string[] {
    // Try JSON array first
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      try {
        const arr = JSON.parse(jsonMatch[0]);
        if (Array.isArray(arr) && arr.length > 0 && arr.every((item) => typeof item === 'string')) {
          return arr.map((s) => s.trim()).filter(Boolean);
        }
      } catch {}
    }
    // Fallback: treat as comma/newline separated
    return content
      .replace(/["'`]/g, '')
      .split(/[,，;；\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s.length < 50);
  }

  const handleFill = useCallback(async () => {
    const confirmedMappings = mappings.filter((m) => m.userConfirmed && m.targetField.selector);
    if (!confirmedMappings.length) { setStatus({ type: 'error', text: '没有可填写的映射' }); return; }

    // Check if we should use Canvas mode (copy to clipboard instead of DOM fill)
    const isCanvasMode = canvasInfo?.detected;

    if (isCanvasMode) {
      // Canvas mode: generate labeled TSV data and copy to clipboard
      // Sort by column order to maintain correct column sequence
      const sorted = [...confirmedMappings].sort((a, b) => {
        const aIdx = parseInt(a.targetField.selector.replace('__canvas_col_', '').replace('__', ''), 10) || 0;
        const bIdx = parseInt(b.targetField.selector.replace('__canvas_col_', '').replace('__', ''), 10) || 0;
        return aIdx - bIdx;
      });

      let tsvContent: string;
      if (parsedRows.length > 1) {
        // 多行数据：每张截图一行
        const lines: string[] = [];
        for (const row of parsedRows) {
          const lineValues = sorted.map((m) => {
            // 在当前行中查找与 mapping 同名字段的值
            const found = row.find((f) => f.field === m.sourceField.field);
            return found?.value || m.sourceField.value; // fallback to first row
          });
          lines.push(lineValues.join('\t'));
        }
        tsvContent = lines.join('\n');
      } else {
        tsvContent = sorted.map((m) => m.sourceField.value).join('\t');
      }

      try {
        await navigator.clipboard.writeText(tsvContent);
        setCopiedToClipboard(true);
      } catch {
        setCopiedToClipboard(false);
      }
      setFillResult({ total: confirmedMappings.length, success: confirmedMappings.length, failed: 0 });
      setStep('done');
      const rowHint = parsedRows.length > 1 ? `（共 ${parsedRows.length} 行）` : '';
      setStatus({ type: 'success', text: `已生成 ${confirmedMappings.length} 个字段的对应数据${rowHint}` });

      // Save mapping history
      try {
        await sendMessage('SAVE_MAPPING_HISTORY', { urlPattern: 'canvas-fill', mappings: confirmedMappings });
      } catch {}
      return;
    }

    // Virtual manual mode: copy data to clipboard for manual paste
    if (pageMode === 'virtual-manual') {
      setStep('filling');
      // 将确认的映射数据格式化为易粘贴的格式
      const lines = confirmedMappings.map((m) => `${m.targetField.label}：${m.sourceField.value}`);
      const textContent = lines.join('\n');

      // 如果有多行数据，也生成 TSV 格式
      let multiLineText = '';
      if (parsedRows.length > 1) {
        const headerLine = confirmedMappings.map((m) => m.targetField.label).join('\t');
        const dataLines = parsedRows.map((row) =>
          confirmedMappings.map((m) => row.find((f) => f.field === m.sourceField.field)?.value || m.sourceField.value).join('\t')
        );
        multiLineText = headerLine + '\n' + dataLines.join('\n');
      }

      const clipboardText = parsedRows.length > 1 ? multiLineText : textContent;

      try {
        await navigator.clipboard.writeText(clipboardText);
        setCopiedToClipboard(true);
      } catch {
        setCopiedToClipboard(false);
      }

      setFillResult({ total: confirmedMappings.length, success: confirmedMappings.length, failed: 0 });
      setCanUndo(false);
      setStep('done');
      const rowHint = parsedRows.length > 1 ? `（共 ${parsedRows.length} 行，含表头）` : '';
      setStatus({ type: 'success', text: `已将 ${confirmedMappings.length} 个字段数据复制到剪贴板${rowHint}，请手动粘贴到目标位置` });
      try {
        await sendMessage('SAVE_MAPPING_HISTORY', { urlPattern: 'virtual-manual', mappings: confirmedMappings });
      } catch {}
      return;
    }

    // Table Modal fill mode (for Coze/Dify/小建工 style editors)
    if (pageMode === 'table-modal' && tableModalData) {
      setStep('filling');
      try {
        // 判断是否有多行数据
        const multiRowData = parsedRows.length > 1 ? parsedRows : null;

        if (multiRowData) {
          // 多行填写流程
          const dataRows = multiRowData.map((row) =>
            confirmedMappings.map((m) => ({
              fieldName: m.sourceField.field,
              value: row.find((f) => f.field === m.sourceField.field)?.value || m.sourceField.value,
            }))
          );

          setStatus({ type: 'loading', text: `正在填写第 1/${dataRows.length} 行（Agent 模式）...` });
          setAgentProgress({ current: 1, total: dataRows.length });

          const result = await sendMessage<{ totalRows: number; filledRows: number; errors: string[] }>(
            'FILL_TABLE_MULTI_ROW',
            { dataRows, tableInfo: tableModalData }
          );

          setAgentProgress(null);
          setFillResult({ total: dataRows.length, success: result.filledRows, failed: dataRows.length - result.filledRows });
          setCanUndo(false);
          setStep('done');
          const errorHint = result.errors.length > 0 ? `（${result.errors.length} 个警告）` : '';
          setStatus({ type: 'success', text: `Agent 模式: 自动填写了 ${result.filledRows}/${dataRows.length} 行数据${errorHint}` });
        } else {
          // 单行填写：走现有的 fillTableModal
          setStatus({ type: 'loading', text: '正在填写表格弹窗（Agent 模式）...' });

          const tableMappings = confirmedMappings.map((m) => ({
            sourceField: m.sourceField.field,
            value: m.sourceField.value,
            targetHeader: m.targetField.label,
          }));

          const result = await sendMessage<{ total: number; success: number; failed: number; error?: string }>(
            'FILL_TABLE_MODAL',
            { mappings: tableMappings, tableInfo: tableModalData }
          );

          if (result.error) throw new Error(result.error);
          setFillResult({ total: result.total || confirmedMappings.length, success: result.success || 0, failed: result.failed || 0 });
          setCanUndo(false);
          setStep('done');
          setStatus({ type: 'success', text: `表格填写完成：${result.success || 0}/${confirmedMappings.length} 个字段成功` });
        }

        // Save history
        try {
          const tab = await getCurrentTab();
          const url = (await sendMessageToTab<{ url: string }>(tab.id!, 'SCAN_FORM')).url;
          await sendMessage('SAVE_MAPPING_HISTORY', { urlPattern: url, mappings: confirmedMappings });
        } catch {}
      } catch (err: any) {
        setAgentProgress(null);
        setStatus({ type: 'error', text: '表格填写失败: ' + (err.message || '请确认弹窗已打开') });
        setStep('mapping');
      }
      return;
    }

    // Standard DOM fill mode
    setStep('filling');
    setStatus({ type: 'loading', text: '正在填写表单...' });
    try {
      const tab = await getCurrentTab();
      let result: { total: number; success: number; failed: number };

      try {
        result = await sendMessageToTab<{ total: number; success: number; failed: number }>(tab.id!, 'FILL_FORM', { mappings: confirmedMappings });
      } catch (fillErr: any) {
        // Try dynamic injection
        try {
          await chrome.scripting.executeScript({ target: { tabId: tab.id! }, files: ['content.js'] });
          await new Promise((r) => setTimeout(r, 500));
          result = await sendMessageToTab<{ total: number; success: number; failed: number }>(tab.id!, 'FILL_FORM', { mappings: confirmedMappings });
        } catch {
          setStatus({ type: 'error', text: '填写失败：无法连接到当前页面，请刷新页面后重试' });
          setStep('mapping');
          return;
        }
      }
      setFillResult(result);
      setCanUndo(!isCanvasMode); // Canvas fill doesn't support undo yet
      setStep('done');
      setStatus({ type: 'success', text: `填写完成：${result.success}/${result.total} 个字段成功` });
      try {
        const url = (await sendMessageToTab<{ url: string }>(tab.id!, 'SCAN_FORM')).url;
        await sendMessage('SAVE_MAPPING_HISTORY', { urlPattern: url, mappings: confirmedMappings });
      } catch {}
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '填写失败' });
      setStep('mapping');
    }
  }, [mappings, canvasInfo, parsedRows, pageMode, tableModalData]);

  const handleUndo = useCallback(async () => {
    try {
      const tab = await getCurrentTab();
      const result = await sendMessageToTab<{ total: number; success: number }>(tab.id!, 'UNDO_FILL');
      setCanUndo(false);
      setStatus({ type: 'info', text: `已撤销 ${result.success}/${result.total} 个字段` });
    } catch (err: any) {
      setStatus({ type: 'error', text: '撤销失败: ' + err.message });
    }
  }, []);

  const handleAddManualMapping = () => {
    if (manualTargetIdx < 0 || !manualField.trim()) return;
    const target = formFields[manualTargetIdx];
    if (!target) return;
    const newMapping: MappingResult = {
      sourceField: { field: manualField.trim(), value: manualValue.trim(), type: 'text', confidence: 1 },
      targetField: target,
      confidence: 1,
      status: 'auto',
      userConfirmed: true,
    };
    setMappings((prev) => [...prev, newMapping]);
    setManualField('');
    setManualValue('');
    setManualTargetIdx(-1);
    setShowManualAdd(false);
  };

  // Agent 逐行填写：直接在小建工等页面上逐行新增+填写
  const handleRowByRowFill = useCallback(async () => {
    // Check if data has row-grouped format (e.g. "1.名称", "2.名称")
    const groups: Record<string, ParsedField[]> = {};
    parsedFields.forEach((f) => {
      const match = f.field.match(/^(\d+)\./);
      const key = match ? match[1] : '_flat';
      if (!groups[key]) groups[key] = [];
      groups[key].push(f);
    });
    const rowKeys = Object.keys(groups).filter((k) => k !== '_flat').sort((a, b) => +a - +b);

    if (rowKeys.length === 0) {
      setStatus({ type: 'error', text: '数据不是表格格式，请使用"扫描页面并填写"模式' });
      return;
    }

    setLoading(true);
    setStep('filling');
    setStatus({ type: 'loading', text: `Agent 正在逐行填写（共 ${rowKeys.length} 行）...` });
    setAgentProgress({ current: 0, total: rowKeys.length });

    try {
      const dataRows = rowKeys.map((key) =>
        groups[key].map((f) => ({
          colName: f.field.replace(/^\d+\./, ''),
          value: f.value,
          type: f.type,
        }))
      );

      // Inject content script first (ensure agentScanner is loaded)
      const tab = await getCurrentTab();
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id! },
          files: ['content.js'],
        });
        await new Promise((r) => setTimeout(r, 800));
      } catch (injectErr: any) {
        throw new Error('无法注入脚本到目标页面: ' + injectErr.message);
      }

      // Send fill message
      const result = await sendMessage<{ totalRows: number; filledRows: number; errors: string[] }>(
        'FILL_ROW_BY_ROW',
        { dataRows }
      );

      setAgentProgress(null);
      setFillResult({ total: result.totalRows, success: result.filledRows, failed: result.totalRows - result.filledRows });
      setCanUndo(false);
      setStep('done');
      const errHint = result.errors.length > 0 ? `（${result.errors.length} 个警告）` : '';
      setStatus({ type: 'success', text: `逐行填写完成：${result.filledRows}/${result.totalRows} 行成功${errHint}` });
    } catch (err: any) {
      setAgentProgress(null);
      setStatus({ type: 'error', text: '逐行填写失败: ' + (err.message || '未知错误') });
      setStep('data-review');
    }
    setLoading(false);
  }, [parsedFields]);

  // Load history
  const handleLoadHistory = useCallback(async () => {
    try {
      const entries = await sendMessage<{ key: string; data: any; label: string; timestamp: number; type: string }[]>('GET_MAPPING_HISTORY', {});
      setHistoryEntries(entries || []);
      setShowHistory(true);
    } catch {}
  }, []);

  // Restore from history entry
  const handleRestoreHistory = useCallback((entry: { key: string; data: any }) => {
    if (entry.data.parsedFields) {
      setParsedFields(entry.data.parsedFields);
      setStep(entry.data.step === 'data-review' ? 'data-review' : 'input');
      setShowHistory(false);
      setStatus({ type: 'success', text: '已恢复历史记录' });
    }
  }, []);

  // Save current data to manual slot
  const handleSaveManual = useCallback(async (slot: number) => {
    const label = prompt('请输入保存名称（可选）：') || `手动保存 ${slot + 1}`;
    await sendMessage('SAVE_MAPPING_HISTORY', {
      type: 'manual', slot, label,
      data: { parsedFields, textContent, step },
    });
    setStatus({ type: 'success', text: `已保存到手动槽位 ${slot + 1}` });
  }, [parsedFields, textContent]);

  // Auto-save after successful fill
  useEffect(() => {
    if (step === 'done' && parsedFields.length > 0) {
      sendMessage('SAVE_MAPPING_HISTORY', {
        type: 'auto',
        label: `${parsedFields.length} 个字段`,
        data: { parsedFields, textContent },
      }).catch(() => {});
    }
  }, [step]);

  const handleReset = () => {
    setStep('input'); setImagePreviews([]); setImagesBase64([]); setTextContent('');
    setParsedFields([]); setParsedRows([]); setFormFields([]); setMappings([]); setFillResult(null);
    setStatus(null); setLoading(false); setFileName(null); setFileData(null);
    setNewButtons(null); setCanUndo(false); setCanvasInfo(null); setCanvasColumns('');
    setCopiedToClipboard(false); setScanningColumns(false);
    setAgentProgress(null); setPageMode('standard'); setTableModalData(null); setModalButtons(null);
    setTargetImages([]); setTargetPreviews([]);
    clearPopupState().catch(() => {});
  };

  // AI-powered matching: use user-provided target screenshots + page scan
  const handleAiMatch = useCallback(async () => {
    if (!settings?.apiKey) {
      setStatus({ type: 'error', text: '请先在设置中配置 API Key' });
      return;
    }
    setLoading(true);
    setStatus({ type: 'loading', text: 'AI 正在分析页面与数据的匹配关系...' });
    try {
      const result = await sendMessage<{ mappings?: { sourceField: string; targetSelector: string; confidence: number }[]; error?: string }>(
        'AI_MATCH_FIELDS',
        { parsedFields, formFields, targetImages, pageUrl: (await getCurrentTab()).url }
      );
      if (result.error) throw new Error(result.error);
      if (result.mappings?.length) {
        setMappings((prev) =>
          prev.map((m) => {
            const aiMatch = result.mappings!.find((am) => am.sourceField === m.sourceField.field);
            if (aiMatch) {
              const target = formFields.find((f) => f.selector === aiMatch.targetSelector);
              if (target) {
                return { ...m, targetField: target, confidence: aiMatch.confidence, status: 'auto' as const, userConfirmed: true };
              }
            }
            return m;
          })
        );
        setStatus({ type: 'success', text: `AI 智能匹配完成，已匹配 ${result.mappings.length} 个字段` });
      } else {
        setStatus({ type: 'info', text: 'AI 未能自动匹配，请手动选择' });
      }
    } catch (err: any) {
      setStatus({ type: 'error', text: 'AI 匹配失败: ' + (err.message || '未知错误') });
    }
    setLoading(false);
  }, [settings, parsedFields, formFields, targetImages]);

  const openSettings = () => { chrome.runtime.openOptionsPage(); };

  const canProcess = inputMode === 'image' ? imagesBase64.length > 0 : inputMode === 'text' ? !!textContent.trim() : !!fileName;

  if (restoring) {
    return (
      <div className="app" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200 }}>
        <span className="status-spinner" />
        <span style={{ marginLeft: 8, color: 'var(--muted)' }}>恢复状态中...</span>
      </div>
    );
  }

  return (
    <div className="app" onPaste={handlePaste}>
      <div className="header">
        <h1>FormSnap</h1>
        <div className="header-actions">
          <button className="icon-btn" onClick={handleLoadHistory} title="查看历史">📁</button>
          <button className="icon-btn" onClick={openSettings} title="设置">⚙</button>
        </div>
      </div>

      {/* History Panel */}
      {showHistory && (
        <div style={{ marginBottom: 12, padding: '10px', background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontWeight: 600, fontSize: 13, color: '#374151' }}>历史记录</span>
            <div>
              <button className="icon-btn" onClick={() => setShowHistory(false)} style={{ fontSize: 14 }}>✕</button>
            </div>
          </div>
          {historyEntries.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9ca3af', textAlign: 'center', padding: '12px 0' }}>暂无历史记录</div>
          ) : (
            <div style={{ maxHeight: 200, overflowY: 'auto' }}>
              {historyEntries.map((entry) => (
                <div key={entry.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f3f4f6', fontSize: 11 }}>
                  <div>
                    <div style={{ color: '#374151', fontWeight: 500 }}>{entry.label || (entry.type === 'auto' ? '自动保存' : '手动保存')}</div>
                    <div style={{ color: '#9ca3af', fontSize: 10 }}>{new Date(entry.timestamp).toLocaleString()} · {entry.data.parsedFields?.length || 0} 字段</div>
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn btn-outline" style={{ fontSize: 10, padding: '2px 8px' }}
                      onClick={() => handleRestoreHistory(entry)}>恢复</button>
                    {entry.type === 'manual' && (
                      <button className="btn btn-outline" style={{ fontSize: 10, padding: '2px 8px', color: '#ef4444', borderColor: '#fca5a5' }}
                        onClick={async () => { await sendMessage('DELETE_HISTORY_ENTRY', { key: entry.key }); handleLoadHistory(); }}>删除</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
          {/* Manual save slots */}
          <div style={{ marginTop: 8, borderTop: '1px solid #e5e7eb', paddingTop: 8 }}>
            <div style={{ fontSize: 11, color: '#6b7280', marginBottom: 4 }}>手动保存槽位：</div>
            <div style={{ display: 'flex', gap: 4 }}>
              {[0, 1, 2].map((slot) => {
                const existing = historyEntries.find((e) => e.key === `history_manual_${slot}`);
                return (
                  <button key={slot} className="btn btn-outline" style={{ flex: 1, fontSize: 10, padding: '4px' }}
                    onClick={() => existing ? handleRestoreHistory(existing) : handleSaveManual(slot)}
                    disabled={parsedFields.length === 0 && !existing}>
                    {existing ? `槽${slot + 1}: ${existing.label.slice(0, 6)}` : `保存到槽${slot + 1}`}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {apiKeyMissing && inputMode !== 'file' && (
        <div className="status-bar error" style={{ marginBottom: 10 }}>
          请先在设置中配置 API Key
          <button className="icon-btn" onClick={openSettings} style={{ marginLeft: 'auto', fontSize: 11 }}>去设置</button>
        </div>
      )}

      {status && step !== 'done' && (
        <div className={`status-bar ${status.type}`}>
          {status.type === 'loading' && <span className="status-spinner" />}
          {status.text}
        </div>
      )}

      {/* New buttons suggestion */}
      {newButtons && newButtons.length > 0 && step === 'input' && !loading && (
        <div style={{ padding: '8px 12px', background: '#fff8e6', border: '1px solid #ffd666', borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>当前页面需要先创建输入行才能填写</div>
          <div style={{ color: 'var(--muted)', marginBottom: 8 }}>检测到以下按钮，点击可自动创建表单：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {newButtons.map((btn, i) => (
              <button key={i} className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px' }} onClick={() => handleClickNewButton(btn.selector)}>
                {btn.text || '新建'}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Modal/drawer buttons suggestion */}
      {modalButtons && modalButtons.length > 0 && step === 'input' && !loading && (
        <div style={{ padding: '8px 12px', background: '#EFF6FF', border: '1px solid #BFDBFE', borderRadius: 6, marginBottom: 10, fontSize: 12 }}>
          <div style={{ marginBottom: 6, fontWeight: 500 }}>未找到表单，可能需要先打开弹窗</div>
          <div style={{ color: 'var(--muted)', marginBottom: 8 }}>检测到以下按钮，点击可自动打开并重新扫描：</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {modalButtons.map((btn, i) => (
              <button key={i} className="btn btn-outline" style={{ fontSize: 11, padding: '4px 10px', borderColor: '#3B82F6', color: '#3B82F6' }} onClick={() => handleClickModalButton(btn.selector)}>
                {btn.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Step: Input */}
      {step === 'input' && !loading && (
        <>
          <div className="tabs">
            <button className={`tab ${inputMode === 'image' ? 'active' : ''}`} onClick={() => setInputMode('image')}>截图上传</button>
            <button className={`tab ${inputMode === 'text' ? 'active' : ''}`} onClick={() => setInputMode('text')}>文本输入</button>
            <button className={`tab ${inputMode === 'file' ? 'active' : ''}`} onClick={() => setInputMode('file')}>文件上传</button>
          </div>

          {inputMode === 'image' ? (
            <div className="input-section">
              <div className="drop-zone"
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
                onDragLeave={(e) => e.currentTarget.classList.remove('dragover')}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}>
                {imagePreviews.length > 0 ? (
                  <>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {imagePreviews.map((src, i) => (
                        <img key={i} src={src} className="preview-image" alt={`预览${i+1}`} style={{ maxHeight: 80, maxWidth: '48%' }} />
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4 }}>{imagePreviews.length} 张截图</div>
                  </>
                ) : (
                  <>
                    <div className="drop-zone-icon">📎</div>
                    <div className="drop-zone-text">拖入/粘贴 待填数据截图</div>
                    <div className="drop-zone-hint">包含字段名和值的数据截图（最多 {MAX_IMAGES} 张）</div>
                  </>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileChange} />
              {imagePreviews.length > 0 && (
                <button className="btn btn-outline" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setImagePreviews([]); setImagesBase64([]); }}>清除数据截图</button>
              )}

              {/* Target page screenshot upload (optional) */}
              <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(139,92,246,0.04)', border: '1px dashed rgba(139,92,246,0.3)', borderRadius: 8, fontSize: 11 }}>
                <div style={{ fontWeight: 600, color: '#7c3aed', marginBottom: 4 }}>目标页面截图（可选，帮助 AI 更好地匹配字段）</div>
                <div className="drop-zone" style={{ minHeight: 50, padding: '8px', background: 'rgba(139,92,246,0.02)', borderColor: 'rgba(139,92,246,0.2)' }}
                  onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
                  onDragLeave={(e) => e.currentTarget.classList.remove('dragover')}
                  onDrop={(e) => {
                    e.preventDefault(); e.currentTarget.classList.remove('dragover');
                    const files = e.dataTransfer.files;
                    if (files) Array.from(files).filter((f) => f.type.startsWith('image/')).forEach((f) => handleTargetImage(f));
                  }}
                  onClick={() => targetFileInputRef.current?.click()}>
                  {targetPreviews.length > 0 ? (
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {targetPreviews.map((src, i) => (
                        <img key={i} src={src} className="preview-image" alt={`目标${i+1}`} style={{ maxHeight: 60, maxWidth: '48%' }} />
                      ))}
                    </div>
                  ) : (
                    <div style={{ color: '#8b5cf6' }}>拖入/粘贴待填页面的截图</div>
                  )}
                </div>
                <input ref={targetFileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={(e) => {
                  const files = e.target.files;
                  if (files) Array.from(files).forEach((f) => handleTargetImage(f));
                }} />
                {targetPreviews.length > 0 && (
                  <button className="btn btn-outline" style={{ width: '100%', marginTop: 4, fontSize: 11, borderColor: '#8b5cf6', color: '#7c3aed' }} onClick={() => { setTargetPreviews([]); setTargetImages([]); }}>清除目标截图</button>
                )}
              </div>
            </div>
          ) : inputMode === 'text' ? (
            <div className="input-section">
              <textarea className="text-input" placeholder={"粘贴配置数据，支持以下格式：\n\n字段名: 值\n字段名 = 值\n| 字段名 | 值 |\n或任意结构化文本"} value={textContent} onChange={(e) => setTextContent(e.target.value)} />
            </div>
          ) : (
            <div className="input-section">
              <div className="drop-zone" onClick={() => excelFileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('dragover'); }}
                onDragLeave={(e) => e.currentTarget.classList.remove('dragover')}
                onDrop={handleDrop}>
                {fileName ? (
                  <>
                    <div className="drop-zone-icon">📄</div>
                    <div className="drop-zone-text">{fileName}</div>
                    <div className="drop-zone-hint">点击重新选择</div>
                  </>
                ) : (
                  <>
                    <div className="drop-zone-icon">📊</div>
                    <div className="drop-zone-text">点击上传 / 拖拽 Excel 或 CSV 文件</div>
                    <div className="drop-zone-hint">支持 .xlsx .xls .csv .tsv（本地解析，无需 API Key，最大 {MAX_FILE_SIZE_MB}MB）</div>
                  </>
                )}
              </div>
              <input ref={excelFileRef} type="file" accept=".xlsx,.xls,.csv,.tsv,.txt" style={{ display: 'none' }} onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  if (f.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
                    setStatus({ type: 'error', text: `文件超过 ${MAX_FILE_SIZE_MB}MB 限制` });
                    setTimeout(() => setStatus(null), 3000);
                    return;
                  }
                  setFileName(f.name); setFileData(f);
                }
              }} />
              {fileName && (
                <button className="btn btn-outline" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setFileName(null); setFileData(null); }}>清除文件</button>
              )}
            </div>
          )}

          <button className="btn btn-primary" onClick={handleParseData} disabled={!canProcess}>
            解析数据
          </button>
        </>
      )}

      {/* Step: Data Review — user confirms parsed data before scanning */}
      {step === 'data-review' && !loading && (
        <div className="data-review-panel">
          <div className="mapping-header">
            <span className="mapping-title">已识别数据</span>
            <span className="mapping-count">{parsedFields.length} 个字段</span>
          </div>

          <div style={{ marginBottom: 12, padding: '8px 10px', background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.15)', borderRadius: 8, fontSize: 11, color: '#16a34a' }}>
            数据解析完成。请确认字段无误后，点击下方按钮扫描页面并填写。
          </div>

          {/* Group parsed fields by row number (from "1.名称" format) */}
          {(() => {
            const groups: Record<string, ParsedField[]> = {};
            parsedFields.forEach((f) => {
              const match = f.field.match(/^(\d+)\./);
              const key = match ? match[1] : '_flat';
              if (!groups[key]) groups[key] = [];
              groups[key].push(f);
            });
            const isGrouped = Object.keys(groups).some((k) => k !== '_flat');
            if (!isGrouped) {
              // Flat display (original)
              return (
                <div style={{ marginBottom: 12, maxHeight: 200, overflowY: 'auto' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead><tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 500 }}>字段</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 500 }}>值</th>
                      <th style={{ textAlign: 'left', padding: '4px 8px', color: '#6b7280', fontWeight: 500 }}>类型</th>
                    </tr></thead>
                    <tbody>
                      {parsedFields.map((f, i) => (
                        <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                          <td style={{ padding: '4px 8px', color: '#374151' }}>{f.field}</td>
                          <td style={{ padding: '4px 8px', color: '#6b7280', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.value || '(空)'}</td>
                          <td style={{ padding: '4px 8px', color: '#9ca3af', fontSize: 11 }}>{f.type}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }
            // Grouped display — each row of the original table is a collapsible group
            const sortedKeys = Object.keys(groups).filter((k) => k !== '_flat').sort((a, b) => +a - +b);
            const flatFields = groups['_flat'] || [];
            return (
              <div style={{ marginBottom: 12, maxHeight: 250, overflowY: 'auto' }}>
                {sortedKeys.map((rowKey) => {
                  const rowFields = groups[rowKey];
                  // Find the "name" field for the row header
                  const nameField = rowFields.find((f) => f.field.includes('名称'));
                  return (
                    <details key={rowKey} style={{ marginBottom: 6, border: '1px solid #e5e7eb', borderRadius: 6 }} open>
                      <summary style={{ padding: '6px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12, color: '#374151', background: '#f9fafb', borderRadius: 6 }}>
                        第 {rowKey} 行{nameField ? ` — ${nameField.value}` : ''}
                        <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 8 }}>({rowFields.length} 个字段)</span>
                      </summary>
                      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                        <tbody>
                          {rowFields.map((f, i) => {
                            const colName = f.field.replace(/^\d+\./, '');
                            return (
                              <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                                <td style={{ padding: '3px 10px', color: '#374151', fontWeight: 500, width: '40%' }}>{colName}</td>
                                <td style={{ padding: '3px 10px', color: '#6b7280' }}>{f.value || '(空)'}</td>
                                <td style={{ padding: '3px 10px', color: '#9ca3af', fontSize: 10 }}>{f.type}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </details>
                  );
                })}
                {flatFields.length > 0 && (
                  <details style={{ marginBottom: 6, border: '1px solid #e5e7eb', borderRadius: 6 }}>
                    <summary style={{ padding: '6px 10px', cursor: 'pointer', fontWeight: 600, fontSize: 12, color: '#374151', background: '#f9fafb', borderRadius: 6 }}>
                      其他字段 <span style={{ fontWeight: 400, color: '#9ca3af', marginLeft: 8 }}>({flatFields.length} 个)</span>
                    </summary>
                    <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                      <tbody>
                        {flatFields.map((f, i) => (
                          <tr key={i} style={{ borderBottom: '1px solid #f3f4f6' }}>
                            <td style={{ padding: '3px 10px', color: '#374151', fontWeight: 500, width: '40%' }}>{f.field}</td>
                            <td style={{ padding: '3px 10px', color: '#6b7280' }}>{f.value || '(空)'}</td>
                            <td style={{ padding: '3px 10px', color: '#9ca3af', fontSize: 10 }}>{f.type}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </details>
                )}
              </div>
            );
          })()}

          {parsedRows.length > 1 && (
            <div style={{ marginBottom: 12, padding: '6px 10px', background: 'rgba(59,130,246,0.06)', borderRadius: 6, fontSize: 11, color: '#2563eb' }}>
              检测到 {parsedRows.length} 行数据，将逐行填写
            </div>
          )}

          <div className="action-bar">
            <button className="btn btn-outline" onClick={handleReset}>返回</button>
            <button className="btn btn-primary" onClick={handleScanAndFill} disabled={loading}
              style={{ fontSize: 12, padding: '6px 12px' }}>
              扫描页面并填写
            </button>
          </div>

          {/* Agent row-by-row fill for table data */}
          {parsedFields.some((f) => /^\d+\./.test(f.field)) && (
            <div style={{ marginTop: 12, padding: '10px 12px', background: 'rgba(139,92,246,0.06)', border: '1px solid rgba(139,92,246,0.2)', borderRadius: 8, fontSize: 12 }}>
              <div style={{ marginBottom: 6, fontWeight: 600, color: '#7c3aed' }}>🤖 Agent 逐行填写模式</div>
              <div style={{ marginBottom: 8, fontSize: 11, color: '#6b7280' }}>
                检测到表格数据（{parsedFields.filter((f) => /^\d+\.名称/.test(f.field)).length} 行）。Agent 将自动：
                点击"+ 新增" → 填写名称/描述/默认值 → 设置开关 → 重复下一行
              </div>
              <div style={{ marginBottom: 8, padding: '6px 10px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 6, fontSize: 11, color: '#b45309' }}>
                请确保目标页面的变量编辑弹窗已打开，且当前行为空行
              </div>
              <button
                className="btn btn-primary"
                onClick={handleRowByRowFill}
                disabled={loading}
                style={{ width: '100%', borderColor: '#8b5cf6', background: '#7c3aed' }}
              >
                开始逐行填写（Agent 自动操作）
              </button>
            </div>
          )}
        </div>
      )}

      {/* Step: Mapping */}
      {step === 'mapping' && (
        <div className="mapping-panel">
          <div className="mapping-header">
            <span className="mapping-title">字段映射</span>
            <span className="mapping-count">{mappings.filter((m) => m.userConfirmed && m.targetField.selector).length}/{mappings.filter((m) => m.targetField.selector).length} 已确认</span>
          </div>

          {/* Manual mapping mode hint */}
          {pageMode === 'manual-mapping' && (
            <div style={{ marginBottom: 12, padding: '10px 12px', background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: 8, fontSize: 12 }}>
              <div style={{ marginBottom: 6, fontWeight: 600, color: '#7c3aed' }}>📋 手动映射模式</div>
              <div style={{ color: 'var(--muted)' }}>
                自动匹配度较低。请在每个字段旁的下拉框中手动选择对应的页面填写位置，确认后 Agent 将自动填写。
              </div>
            </div>
          )}

          {/* Scanned page fields overview */}
          <div style={{ marginBottom: 12, padding: '8px 10px', background: 'rgba(59,130,246,0.04)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 8, fontSize: 11 }}>
            <div style={{ marginBottom: 4, fontWeight: 600, color: '#2563eb' }}>页面上检测到 {formFields.length} 个可填写位置</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {formFields.map((f) => (
                <span key={f.selector} style={{ background: 'rgba(59,130,246,0.08)', padding: '2px 8px', borderRadius: 4, color: '#374151', fontSize: 11 }}>
                  {f.label || f.placeholder || '空'}{f.type !== 'text' ? ` [${f.type}]` : ''}
                </span>
              ))}
            </div>
          </div>

          {/* AI Smart Match button */}
          <button
            className="btn btn-outline"
            onClick={handleAiMatch}
            disabled={loading}
            style={{ width: '100%', marginBottom: 12, padding: '8px', fontSize: 12, borderColor: '#8b5cf6', color: '#7c3aed', borderStyle: 'dashed' }}
          >
            🤖 AI 智能匹配（截图页面让 AI 理解字段对应关系）
          </button>

          {/* Canvas spreadsheet: manual column input */}
          {pageMode === 'virtual-manual' && (
            <div style={{ marginBottom: 12, padding: '10px 12px', background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.2)', borderRadius: 8, fontSize: 12 }}>
              <div style={{ marginBottom: 6, fontWeight: 600, color: '#7c3aed' }}>📋 虚拟字段模式</div>
              <div style={{ marginBottom: 6, color: 'var(--muted)' }}>
                未能自动识别页面表单字段。已根据数据源创建字段列表，点击「填写」后数据将复制到剪贴板。
              </div>
              <div style={{ padding: '6px 10px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 6, fontSize: 11, color: '#2563eb' }}>
                请确认映射关系后点击填写，然后在目标页面 Ctrl+V 粘贴数据。
              </div>
            </div>
          )}

          {/* Canvas spreadsheet: manual column input */}
          {canvasInfo?.detected && (
            <div style={{ marginBottom: 12, padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, fontSize: 12 }}>
              <div style={{ marginBottom: 6, fontWeight: 600, color: '#2563eb' }}>📊 Canvas 表格模式</div>
              <div style={{ marginBottom: 6, color: 'var(--muted)' }}>
                当前页面使用 Canvas 渲染（{canvasInfo.engine === 'spreadjs' ? 'SpreadJS' : '通用'}），无法自动扫描列名。
              </div>
              <div style={{ marginBottom: 8, padding: '6px 10px', background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 6, fontSize: 11, color: '#b45309' }}>
                填写前请先在表格中<strong>点击要填写的起始单元格</strong>
              </div>
              <button
                className="btn btn-primary"
                style={{ width: '100%', marginBottom: 8, fontSize: 12, padding: '6px', opacity: scanningColumns ? 0.6 : 1 }}
                onClick={scanColumnsFromImage}
                disabled={scanningColumns}
              >
                {scanningColumns ? '正在识别...' : '截图当前页面，AI 自动识别列名'}
              </button>
              <div style={{ textAlign: 'center', fontSize: 11, color: 'var(--muted)', marginBottom: 6 }}>或手动输入：</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  type="text"
                  value={canvasColumns}
                  onChange={(e) => setCanvasColumns(e.target.value)}
                  placeholder="列名（逗号分隔）例如：姓名, 年龄, 成绩"
                  style={{ flex: 1, padding: '6px 10px', border: '1px solid #d1d5db', borderRadius: 6, fontSize: 12 }}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyCanvasColumns(); }}
                />
                <button className="btn btn-primary" style={{ fontSize: 11, padding: '4px 12px' }} onClick={applyCanvasColumns}>
                  匹配
                </button>
              </div>
              {canvasInfo.columns && canvasInfo.columns.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted)' }}>
                  自动检测到列名：{canvasInfo.columns.map((c) => c.label).join(', ')}
                </div>
              )}
            </div>
          )}

          {/* Unmatched source fields that have no target column */}
          {mappings.some((m) => !m.targetField.selector && m.status === 'unmatched') && (
            <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 6, fontSize: 11, color: '#b45309' }}>
              以下数据源字段未自动匹配，请从下拉框中手动选择目标位置，勾选后 Agent 自动填写
            </div>
          )}

          <div className="mapping-list">
            {mappings.map((m, i) => (
              <div key={i} className={`mapping-row ${m.status}`}>
                <div
                  className={`mapping-check ${m.userConfirmed && m.targetField.selector ? 'checked' : ''}`}
                  onClick={() => { if (m.targetField.selector) toggleMapping(i); }}
                  style={!m.targetField.selector ? { cursor: 'default', opacity: 0.3 } : {}}
                >
                  {m.userConfirmed && m.targetField.selector ? '✓' : ''}
                </div>
                <div className="mapping-row-content">
                  <div className="mapping-source">
                    <span>{m.sourceField.field}</span>
                    <span className="mapping-value">{m.sourceField.value}</span>
                  </div>
                  {m.targetField.selector ? (
                    <div className="mapping-target">
                      {m.targetField.label}
                      <span className="mapping-arrow"> → </span>
                      <span className={`mapping-confidence ${m.confidence >= 0.95 ? 'high' : m.confidence >= 0.7 ? 'medium' : 'low'}`}>
                        {Math.round(m.confidence * 100)}%
                      </span>
                    </div>
                  ) : (
                    <div className="mapping-target" style={{ color: '#b45309', fontSize: 11 }}>
                      （未匹配，请从下方下拉框选择）
                    </div>
                  )}
                  {/* Always show target selector dropdown for manual mapping */}
                  <select
                    value={m.targetField.selector || ''}
                    onChange={(e) => { if (e.target.value) selectTarget(i, e.target.value); }}
                    style={{
                      marginTop: 4,
                      width: '100%',
                      padding: '3px 6px',
                      borderRadius: 4,
                      border: '1px solid #d1d5db',
                      fontSize: 11,
                      color: '#374151',
                      background: m.targetField.selector ? '#f0fdf4' : '#fff',
                    }}
                  >
                    <option value="">-- 选择目标位置 --</option>
                    {formFields.map((f) => (
                      <option key={f.selector} value={f.selector}>{f.label}{f.placeholder ? ` (${f.placeholder})` : ''}{f.type !== 'text' ? ` [${f.type}]` : ''}</option>
                    ))}
                  </select>
                </div>
              </div>
            ))}
          </div>

          {/* Target fields that have no source data */}
          {(() => {
            const usedTargetSelectors = new Set(mappings.filter((m) => m.targetField.selector).map((m) => m.targetField.selector));
            const missingTargets = formFields.filter((f) => !usedTargetSelectors.has(f.selector));
            if (missingTargets.length === 0) return null;
            return (
              <div style={{ marginTop: 12, padding: '8px 10px', background: 'rgba(245,158,11,0.06)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: 6, fontSize: 11, color: '#d97706' }}>
                <div style={{ marginBottom: 4, fontWeight: 500 }}>以下表格字段缺少数据源，请手动填写：</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {missingTargets.map((f) => (
                    <span key={f.selector} style={{ background: 'rgba(245,158,11,0.1)', padding: '1px 6px', borderRadius: 3 }}>{f.label}</span>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Multi-row hint */}
          {parsedRows.length > 1 && (
            <div style={{ marginTop: 10, padding: '6px 10px', background: 'rgba(59,125,216,0.06)', border: '1px solid rgba(59,125,216,0.15)', borderRadius: 6, fontSize: 11, color: '#2563eb' }}>
              检测到 <strong>{parsedRows.length}</strong> 张截图，将生成 <strong>{parsedRows.length}</strong> 行数据，粘贴时可一次性填入多行
            </div>
          )}

          {/* Manual add field */}
          <div style={{ marginTop: 10 }}>
            <button
              className="btn btn-outline"
              onClick={() => setShowManualAdd(!showManualAdd)}
              style={{ fontSize: 12, padding: '5px 10px' }}
            >
              {showManualAdd ? '取消' : '+ 手动添加字段'}
            </button>
            {showManualAdd && (
              <div style={{ marginTop: 8, padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 8 }}>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input
                    placeholder="字段名"
                    value={manualField}
                    onChange={(e) => setManualField(e.target.value)}
                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 12, width: 80 }}
                  />
                  <input
                    placeholder="值"
                    value={manualValue}
                    onChange={(e) => setManualValue(e.target.value)}
                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 12, width: 80 }}
                  />
                  <select
                    value={manualTargetIdx}
                    onChange={(e) => setManualTargetIdx(Number(e.target.value))}
                    style={{ padding: '4px 8px', borderRadius: 4, border: '1px solid #d1d5db', fontSize: 12 }}
                  >
                    <option value={-1}>选择目标列</option>
                    {formFields.map((f, i) => (
                      <option key={f.selector} value={i}>{f.label}</option>
                    ))}
                  </select>
                  <button
                    className="btn btn-success"
                    style={{ padding: '4px 10px', fontSize: 12 }}
                    onClick={handleAddManualMapping}
                    disabled={!manualField.trim() || manualTargetIdx < 0}
                  >
                    添加
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="action-bar" style={{ marginTop: 12 }}>
            <button className="btn btn-outline" onClick={handleReset}>返回</button>
            <button className="btn btn-success" onClick={handleFill} disabled={!mappings.some((m) => m.userConfirmed && m.targetField.selector)}>
              填写 ({mappings.filter((m) => m.userConfirmed && m.targetField.selector).length})
            </button>
          </div>
        </div>
      )}

      {/* Step: Done */}
      {step === 'done' && (
        <>
          {status && <div className={`status-bar ${status.type}`}>{status.text}</div>}

          {/* Agent 多行填写信息条 */}
          {pageMode === 'table-modal' && fillResult && fillResult.total > 1 && (
            <div style={{
              margin: '8px 0',
              padding: '8px 12px',
              background: 'rgba(34,197,94,0.06)',
              border: '1px solid rgba(34,197,94,0.2)',
              borderRadius: 8,
              fontSize: 12,
              color: '#16a34a',
              fontWeight: 500,
            }}>
              Agent 模式: 自动填写了 {fillResult.success} 行数据
            </div>
          )}

          {/* Canvas mode: show field→value mapping table and paste instructions */}
          {canvasInfo?.detected && (
            <div style={{ margin: '10px 0' }}>
              {/* Paste instructions */}
              <div style={{
                padding: '10px 12px',
                background: 'rgba(34,197,94,0.06)',
                border: '1px solid rgba(34,197,94,0.2)',
                borderRadius: 8, fontSize: 12
              }}>
                <div style={{ fontWeight: 600, color: '#16a34a', marginBottom: 4 }}>
                  {copiedToClipboard ? '✅ 数据已复制到剪贴板' : '📋 请手动复制下方数据'}
                </div>
                <ol style={{ margin: 0, paddingLeft: 18, color: '#374151', lineHeight: 1.8 }}>
                  <li>点击表格中<strong>要填写的起始单元格</strong></li>
                  <li>按 <kbd style={{ padding: '1px 6px', background: '#f3f4f6', border: '1px solid #d1d5db', borderRadius: 3, fontSize: 11 }}>Ctrl+V</kbd> 粘贴</li>
                </ol>
              </div>

              {/* Field→Value mapping table */}
              <div style={{ marginTop: 8, fontSize: 11 }}>
                <div style={{
                  padding: '6px 10px', background: '#f8fafc', borderRadius: '6px 6px 0 0',
                  borderBottom: '1px solid #e2e8f0', fontWeight: 600, color: '#475569',
                  display: 'flex', justifyContent: 'space-between'
                }}>
                  <span>目标列</span>
                  <span>填写值</span>
                </div>
                {mappings
                  .filter(m => m.userConfirmed && m.targetField.selector)
                  .sort((a, b) => {
                    const aIdx = parseInt(a.targetField.selector.replace('__canvas_col_', '').replace('__', ''), 10) || 0;
                    const bIdx = parseInt(b.targetField.selector.replace('__canvas_col_', '').replace('__', ''), 10) || 0;
                    return aIdx - bIdx;
                  })
                  .map((m, i) => (
                    <div key={i} style={{
                      padding: '5px 10px', borderBottom: i % 2 === 0 ? '1px solid #f1f5f9' : 'none',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                    }}>
                      <span style={{ color: '#2563eb', fontWeight: 500 }}>{m.targetField.label}</span>
                      <span style={{
                        color: '#1f2937',
                        fontFamily: 'monospace',
                        background: '#fefce8',
                        padding: '1px 6px',
                        borderRadius: 3,
                        fontSize: 11,
                        maxWidth: 180,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap'
                      }}>
                        {m.sourceField.value}
                      </span>
                    </div>
                  ))
                }
                <div style={{
                  padding: '6px 10px', background: '#f8fafc', borderRadius: '0 0 6px 6px',
                  borderTop: '1px solid #e2e8f0', fontSize: 10, color: '#94a3b8', textAlign: 'center'
                }}>
                  共 {mappings.filter(m => m.userConfirmed && m.targetField.selector).length} 个字段 · 按 Tab 顺序排列
                </div>
              </div>

              {/* Raw TSV for manual copy */}
              {!copiedToClipboard && (
                <div style={{ marginTop: 8, padding: '8px', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6 }}>
                  <div style={{ fontSize: 10, color: '#92400e', marginBottom: 4 }}>手动复制（Tab分隔）：</div>
                  <div style={{ fontFamily: 'monospace', fontSize: 10, wordBreak: 'break-all', color: '#78350f', userSelect: 'all' }}>
                    {mappings.filter(m => m.userConfirmed && m.targetField.selector)
                      .sort((a, b) => {
                        const aIdx = parseInt(a.targetField.selector.replace('__canvas_col_', '').replace('__', ''), 10) || 0;
                        const bIdx = parseInt(b.targetField.selector.replace('__canvas_col_', '').replace('__', ''), 10) || 0;
                        return aIdx - bIdx;
                      })
                      .map(m => m.sourceField.value).join('\t')}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Show fill details for standard mode */}
          {fillResult && !canvasInfo?.detected && (
            <div className="mapping-list" style={{ maxHeight: 120, overflow: 'auto' }}>
              {mappings.filter(m => m.userConfirmed).map((m, i) => (
                <div key={i} className={`mapping-item ${m.targetField.selector ? 'matched' : 'unmatched'}`}>
                  <div className="mapping-source">
                    <span className="mapping-field">{m.sourceField.field}</span>
                    <span className="mapping-value">{m.sourceField.value}</span>
                  </div>
                  <span className="mapping-arrow">→</span>
                  <div className="mapping-target">
                    <span className="mapping-label">{m.targetField.label}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="action-bar">
            {canUndo && (
              <button className="btn btn-outline" onClick={handleUndo}>撤销填写</button>
            )}
            <button
              className="btn btn-outline"
              onClick={() => chrome.runtime.openOptionsPage?.() || window.open(chrome.runtime.getURL('options.html'), '_blank')}
            >
              查看历史
            </button>
            <button className="btn btn-primary" onClick={handleReset}>继续填写</button>
          </div>
        </>
      )}
    </div>
  );
}

function bigramSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[\s\-_]/g, '');
  const nb = b.toLowerCase().replace(/[\s\-_]/g, '');
  if (na === nb) return 1.0;
  if (!na || !nb) return 0;
  const bigrams = (s: string) => { const set = new Set<string>(); for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2)); return set; };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let inter = 0;
  ba.forEach((b) => { if (bb.has(b)) inter++; });
  const union = ba.size + bb.size - inter;
  return union === 0 ? 0 : inter / union;
}
