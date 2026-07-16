import React, { useState, useCallback, useRef, useEffect } from 'react';
import { ParsedField, FormField, MappingResult, ExtensionSettings, NewButtonInfo, CanvasSpreadsheetInfo, CanvasColumn, ModalInfo, FieldType } from '../core/types';
import { sendMessage, sendMessageToTab, getCurrentTab } from '../utils/message';
import { prepareImageForAI, clipboardToBlob } from '../utils/imageUtils';
import { parseFile } from '../utils/fileParser';
import { savePopupState, getPopupState, clearPopupState } from '../utils/storage';

type AppStep = 'input' | 'mapping' | 'filling' | 'done';
type InputMode = 'image' | 'text' | 'file';

const MAX_IMAGES = 10;
const MAX_IMAGE_SIZE_MB = 5;
const MAX_FILE_SIZE_MB = 10;

export default function Popup() {
  const [step, setStep] = useState<AppStep>('input');
  const [inputMode, setInputMode] = useState<InputMode>('image');
  const [imagePreviews, setImagePreviews] = useState<string[]>([]);
  const [imagesBase64, setImagesBase64] = useState<string[]>([]);
  const [textContent, setTextContent] = useState('');
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const excelFileRef = useRef<HTMLInputElement>(null);

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

  const handleProcess = useCallback(async () => {
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
          // 多张截图：逐张独立解析，每张一行数据
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
      setModalButtons(null);
      setScanDepth('standard');
      setStatus({ type: 'loading', text: `已识别 ${fields.length} 个字段，正在扫描页面表单...` });

      // Scan current page (standard scan first)
      const tab = await getCurrentTab();
      let scanResult: { fields: FormField[]; newButtons?: NewButtonInfo[]; canvasInfo?: CanvasSpreadsheetInfo; url: string; title: string };
      try {
        scanResult = await sendMessageToTab<{ fields: FormField[]; newButtons?: NewButtonInfo[]; canvasInfo?: CanvasSpreadsheetInfo; url: string; title: string }>(
          tab.id!, 'SCAN_FORM'
        );
      } catch (scanErr: any) {
        // Content script not injected, try dynamic injection
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id! },
            files: ['content.js'],
          });
          // Wait a moment for the script to initialize
          await new Promise((r) => setTimeout(r, 500));
          scanResult = await sendMessageToTab<{ fields: FormField[]; newButtons?: NewButtonInfo[]; canvasInfo?: CanvasSpreadsheetInfo; url: string; title: string }>(
            tab.id!, 'SCAN_FORM'
          );
        } catch (injectErr: any) {
          setStatus({ type: 'error', text: '无法连接到当前页面。请刷新页面后重试。如果问题持续，请尝试：在扩展管理页点击"刷新"按钮，然后刷新当前网页' });
          setLoading(false);
          return;
        }
      }

      // Save canvas info
      if (scanResult.canvasInfo) {
        setCanvasInfo(scanResult.canvasInfo);
      }

      if (!scanResult?.fields?.length) {
        // Check if it's a Canvas spreadsheet
        if (scanResult.canvasInfo?.detected) {
          setStatus({ type: 'info', text: '检测到 Canvas 表格（如 SpreadJS），需要手动指定列名' });
          setParsedFields(fields);
          setStep('mapping');
          setLoading(false);
          return;
        }
        // No fields found - try deep scan with Shadow DOM support
        setStatus({ type: 'loading', text: '标准扫描未找到表单，尝试深度扫描（含 Shadow DOM）...' });
        setScanDepth('deep');
        try {
          const deepResult = await sendMessage<{ fields?: FormField[]; modals?: ModalInfo[]; error?: string }>('SCAN_FORM_DEEP');
          if (deepResult.fields?.length) {
            scanResult = { ...scanResult, fields: deepResult.fields };
          }
          if (deepResult.modals?.length) {
            setModalButtons(deepResult.modals);
          }
        } catch (deepErr) {
          // Deep scan failed, continue with standard result
        }

        // Still no fields?
        if (!scanResult.fields?.length) {
          // Try table modal scan (for Coze/Dify/小建工 style variable editors)
          setStatus({ type: 'loading', text: '尝试检测表格型弹窗...' });
          try {
            const tableModalResult = await sendMessage<{ detected: boolean; rows?: any[]; headers?: string[]; modalSelector?: string; error?: string }>(
              'SCAN_TABLE_MODAL'
            );
            if (tableModalResult?.detected && tableModalResult.headers?.length) {
              // Convert table modal to FormField format using column headers
              const tableFields: FormField[] = [];
              const headers = tableModalResult.headers;
              const rows = tableModalResult.rows || [];
              
              // Use column headers as field labels, with the first data row's input selectors
              for (let colIdx = 0; colIdx < headers.length; colIdx++) {
                const headerName = headers[colIdx];
                // Find the first row's input for this column
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
                  tableFields.push({
                    label: headerName,
                    selector,
                    type: fieldType,
                  });
                }
              }

              if (tableFields.length > 0) {
                scanResult = { ...scanResult, fields: tableFields };
                // Store table modal info for later use in filling
                setPageMode('table-modal');
                setTableModalData({
                  headers: tableModalResult.headers,
                  rows: tableModalResult.rows || [],
                  modalSelector: tableModalResult.modalSelector || '',
                });
              }
            }
          } catch (tableErr) {
            // Table modal scan failed, continue
          }

          // If still no fields after all attempts
          if (!scanResult.fields?.length) {
            if (scanResult.newButtons && scanResult.newButtons.length > 0) {
              setNewButtons(scanResult.newButtons);
              setStatus({ type: 'info', text: `当前页面没有可填写的表单，检测到 ${scanResult.newButtons.length} 个"新建"按钮` });
            } else if (modalButtons && modalButtons.length > 0) {
              setStatus({ type: 'info', text: `未找到表单，但检测到 ${modalButtons.length} 个弹窗/设置按钮，请先点击打开` });
            } else {
              setStatus({ type: 'error', text: '当前页面未检测到表单字段。可能需要先点击弹窗或展开编辑区域' });
            }
            setLoading(false);
            return;
          }
        }
      }

      await proceedWithScanResult(fields, scanResult);
    } catch (err: any) {
      setStatus({ type: 'error', text: err.message || '处理失败' });
      setLoading(false);
    }
  }, [imagesBase64, textContent, inputMode, fileData]);

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

    // Table Modal fill mode (for Coze/Dify/小建工 style editors)
    if (pageMode === 'table-modal' && tableModalData) {
      setStatus({ type: 'loading', text: '正在填写表格弹窗（Agent 模式）...' });
      setStep('filling');
      try {
        // Build fill mappings for table modal: sourceField → headerName
        const tableMappings = confirmedMappings.map((m) => ({
          sourceField: m.sourceField.field,
          value: m.sourceField.value,
          targetHeader: m.targetField.label, // Use header name as target
        }));

        const result = await sendMessage<{ total: number; success: number; failed: number; error?: string }>(
          'FILL_TABLE_MODAL',
          { mappings: tableMappings, tableInfo: tableModalData }
        );

        if (result.error) throw new Error(result.error);
        setFillResult({ total: result.total || confirmedMappings.length, success: result.success || 0, failed: result.failed || 0 });
        setCanUndo(false); // Table modal fill uses React native setter, undo not supported
        setStep('done');
        setStatus({ type: 'success', text: `表格填写完成：${result.success || 0}/${confirmedMappings.length} 个字段成功` });

        // Save history
        try {
          const tab = await getCurrentTab();
          const url = (await sendMessageToTab<{ url: string }>(tab.id!, 'SCAN_FORM')).url;
          await sendMessage('SAVE_MAPPING_HISTORY', { urlPattern: url, mappings: confirmedMappings });
        } catch {}
      } catch (err: any) {
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
  }, [mappings, canvasInfo]);

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

  const handleReset = () => {
    setStep('input'); setImagePreviews([]); setImagesBase64([]); setTextContent('');
    setParsedFields([]); setParsedRows([]); setFormFields([]); setMappings([]); setFillResult(null);
    setStatus(null); setLoading(false); setFileName(null); setFileData(null);
    setNewButtons(null); setCanUndo(false); setCanvasInfo(null); setCanvasColumns('');
    setCopiedToClipboard(false); setScanningColumns(false);
    clearPopupState().catch(() => {});
  };

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
          <button className="icon-btn" onClick={openSettings} title="设置">⚙</button>
        </div>
      </div>

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
                    <div className="drop-zone-text">点击上传 / 拖拽 / Ctrl+V 粘贴截图</div>
                    <div className="drop-zone-hint">支持 PNG, JPG, WebP（最多 {MAX_IMAGES} 张，每张 {MAX_IMAGE_SIZE_MB}MB）</div>
                  </>
                )}
              </div>
              <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFileChange} />
              {imagePreviews.length > 0 && (
                <button className="btn btn-outline" style={{ width: '100%', marginBottom: 8 }} onClick={() => { setImagePreviews([]); setImagesBase64([]); }}>清除所有截图</button>
              )}
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

          <button className="btn btn-primary" onClick={handleProcess} disabled={!canProcess}>
            解析并匹配
          </button>
        </>
      )}

      {/* Step: Mapping */}
      {step === 'mapping' && (
        <div className="mapping-panel">
          <div className="mapping-header">
            <span className="mapping-title">字段映射</span>
            <span className="mapping-count">{mappings.filter((m) => m.userConfirmed && m.targetField.selector).length}/{mappings.filter((m) => m.targetField.selector).length} 已确认</span>
          </div>

          {/* Canvas spreadsheet: manual column input */}
          {canvasInfo?.detected && (
            <div style={{ marginBottom: 12, padding: '10px 12px', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: 8, fontSize: 12 }}>
              <div style={{ marginBottom: 6, fontWeight: 600, color: '#2563eb' }}>📊 Canvas 表格模式</div>
              <div style={{ marginBottom: 6, color: 'var(--muted)' }}>
                当前页面使用 Canvas 渲染（{canvasInfo.engine === 'spreadjs' ? 'SpreadJS' : '通用'}），无法自动扫描列名。
              </div>
              <div style={{ marginBottom: 8, padding: '6px 10px', background: 'rgba(255,165,0,0.08)', border: '1px solid rgba(255,165,0,0.2)', borderRadius: 6, fontSize: 11, color: '#b45309' }}>
                ⚠️ 填写前请先在表格中<strong>点击要填写的起始单元格</strong>
              </div>
              {/* Screenshot scan button */}
              <button
                className="btn btn-primary"
                style={{ width: '100%', marginBottom: 8, fontSize: 12, padding: '6px', opacity: scanningColumns ? 0.6 : 1 }}
                onClick={scanColumnsFromImage}
                disabled={scanningColumns}
              >
                {scanningColumns ? '🔍 正在识别...' : '📸 截图当前页面，AI 自动识别列名'}
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
            <div style={{ marginBottom: 10, padding: '8px 10px', background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', borderRadius: 6, fontSize: 11, color: '#ef4444' }}>
              以下数据源字段在当前表格中<strong>无对应列</strong>，已自动跳过
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
                    <div className="mapping-target" style={{ color: '#ef4444', fontSize: 11 }}>
                      （当前页面无对应列）
                    </div>
                  )}
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
