import { FormSnapMessage, ExtensionSettings, ParsedField, ScanFormResult, FillFormResult, MappingHistoryEntry } from '../core/types';
import { getSettings, saveSettings } from '../utils/storage';
import { parseDataSource } from '../core/aiEngine';

chrome.runtime.onMessage.addListener(
  (message: FormSnapMessage, sender, sendResponse) => {
    // Validate sender: only accept messages from our own extension
    if (sender.id !== chrome.runtime.id) {
      console.warn('FormSnap: rejected message from unknown sender:', sender.id);
      return false;
    }
    switch (message.type) {
      case 'GET_SETTINGS': {
        getSettings().then((settings) => sendResponse(settings));
        return true; // async
      }

      case 'CAPTURE_TAB': {
        chrome.tabs.captureVisibleTab(null as any, { format: 'png', quality: 100 }, (dataUrl) => {
          if (chrome.runtime.lastError) {
            sendResponse({ error: chrome.runtime.lastError.message });
          } else if (dataUrl) {
            sendResponse({ dataUrl });
          } else {
            sendResponse({ error: '截图失败' });
          }
        });
        return true; // async
      }

      case 'SAVE_SETTINGS': {
        if (!message.payload || typeof message.payload !== 'object') {
          sendResponse(null);
          return false;
        }
        saveSettings(message.payload).then((settings) => sendResponse(settings));
        return true;
      }

      case 'PARSE_DATA_SOURCE': {
        if (!message.payload) {
          sendResponse({ error: 'No input provided', fields: [] });
          return false;
        }
        const { images, text } = message.payload;
        getSettings()
          .then((settings) => {
            if (!settings.apiKey) {
              sendResponse({ error: 'Please set API Key in settings', fields: [] });
              return;
            }
            return parseDataSource(settings, { images, text });
          })
          .then((fields?: ParsedField[]) => {
            sendResponse({ fields: fields || [] });
          })
          .catch((err: Error) => {
            sendResponse({ error: err.message, fields: [] });
          });
        return true;
      }

      case 'SAVE_MAPPING_HISTORY': {
        if (!message.payload) {
          sendResponse({ success: false, error: 'Invalid payload' });
          return false;
        }
        const { type, data, label } = message.payload;
        const key = type === 'manual'
          ? `history_manual_${message.payload.slot || 0}`
          : `history_auto_${Date.now()}`;
        const entry = { data, label: label || '', timestamp: Date.now(), type };
        chrome.storage.local.set({ [key]: entry }, () => {
          if (type === 'auto') {
            // Auto-save: keep only latest 3
            chrome.storage.local.get(null, (all) => {
              const autoKeys = Object.keys(all)
                .filter((k) => k.startsWith('history_auto_'))
                .sort();
              if (autoKeys.length > 3) {
                chrome.storage.local.remove(autoKeys.slice(0, autoKeys.length - 3));
              }
            });
          }
          sendResponse({ success: true });
        });
        return true;
      }

      case 'GET_MAPPING_HISTORY': {
        chrome.storage.local.get(null, (all) => {
          const entries: { key: string; data: any; label: string; timestamp: number; type: string }[] = [];
          // Auto entries (latest 3)
          Object.keys(all)
            .filter((k) => k.startsWith('history_auto_'))
            .sort()
            .reverse()
            .slice(0, 3)
            .forEach((k) => {
              entries.push({ key: k, ...all[k] });
            });
          // Manual entries (3 slots)
          for (let i = 0; i < 3; i++) {
            const k = `history_manual_${i}`;
            if (all[k]) {
              entries.push({ key: k, ...all[k] });
            }
          }
          sendResponse(entries);
        });
        return true;
      }

      case 'DELETE_HISTORY_ENTRY': {
        const { key } = message.payload;
        chrome.storage.local.remove(key, () => sendResponse({ success: true }));
        return true;
      }

      case 'SCAN_FORM_DEEP': {
        // 深度扫描：转发给 content script 执行三级扫描 + 弹窗检测
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) {
            sendResponse({ fields: [], modals: [], error: '未找到活动标签页' });
            return;
          }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_SCAN_DEEP' }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ fields: [], modals: [], error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { fields: [], modals: [] });
            }
          });
        });
        return true;
      }

      case 'DETECT_MODALS': {
        // 转发给 content script 检测弹窗/模态框/抽屉
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) {
            sendResponse({ modals: [], error: '未找到活动标签页' });
            return;
          }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_DETECT_MODALS' }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ modals: [], error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { modals: [] });
            }
          });
        });
        return true;
      }

      case 'SCAN_TABLE_MODAL': {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) {
            sendResponse({ detected: false, error: '未找到活动标签页' });
            return;
          }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_SCAN_TABLE_MODAL' }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ detected: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { detected: false });
            }
          });
        });
        return true;
      }

      case 'ADD_TABLE_ROW': {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) { sendResponse({ success: false, error: '未找到活动标签页' }); return; }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_ADD_TABLE_ROW', payload: message.payload }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ success: false, error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { success: false });
            }
          });
        });
        return true;
      }

      case 'FILL_TABLE_MODAL': {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) { sendResponse({ total: 0, success: 0, failed: 0, error: '未找到活动标签页' }); return; }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_FILL_TABLE_MODAL', payload: message.payload }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ total: 0, success: 0, failed: 0, error: chrome.runtime.lastError.message });
            } else {
              sendResponse(response || { total: 0, success: 0, failed: 0 });
            }
          });
        });
        return true;
      }

      case 'FILL_TABLE_MULTI_ROW': {
        // 转发给 content script 执行多行表格填写
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) {
            sendResponse({ totalRows: 0, filledRows: 0, errors: ['未找到活动标签页'] });
            return;
          }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_FILL_TABLE_MULTI_ROW', payload: message.payload }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ totalRows: 0, filledRows: 0, errors: [chrome.runtime.lastError.message] });
            } else {
              sendResponse(response || { totalRows: 0, filledRows: 0, errors: ['无响应'] });
            }
          });
        });
        return true;
      }

      case 'FILL_ROW_BY_ROW': {
        // 逐行新增填写引擎（小建工风格：点击新增→填写→循环）
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          const tabId = tabs[0]?.id;
          if (!tabId) {
            sendResponse({ totalRows: 0, filledRows: 0, errors: ['未找到活动标签页'] });
            return;
          }
          chrome.tabs.sendMessage(tabId!, { type: 'EXEC_FILL_ROW_BY_ROW', payload: message.payload }, (response) => {
            if (chrome.runtime.lastError) {
              sendResponse({ totalRows: 0, filledRows: 0, errors: [chrome.runtime.lastError.message] });
            } else {
              sendResponse(response || { totalRows: 0, filledRows: 0, errors: ['无响应'] });
            }
          });
        });
        return true;
      }

      case 'AI_MATCH_FIELDS': {
        // AI-powered matching: use user-provided target screenshots
        if (!message.payload || !message.payload.parsedFields || !message.payload.formFields) {
          sendResponse({ error: '缺少字段数据', mappings: [] });
          return false;
        }
        const { parsedFields, formFields, targetImages } = message.payload;
        getSettings().then((settings) => {
          if (!settings.apiKey) {
            sendResponse({ error: '请先设置 API Key', mappings: [] });
            return;
          }
          // Use user-provided target screenshots if available, otherwise captureVisibleTab
          if (targetImages && targetImages.length > 0) {
            (async () => {
              try {
                const { matchFieldsWithAI } = await import('../core/aiEngine');
                // Use first target image for matching
                const mappings = await matchFieldsWithAI(settings, parsedFields, formFields, targetImages[0]);
                sendResponse({ mappings });
              } catch (err: any) {
                sendResponse({ error: err.message, mappings: [] });
              }
            })();
          } else {
            // Fallback: capture current page screenshot
            chrome.tabs.captureVisibleTab(null as any, { format: 'png', quality: 80 }, async (dataUrl) => {
              if (chrome.runtime.lastError || !dataUrl) {
                sendResponse({ error: '截图失败，请手动上传目标页面截图', mappings: [] });
                return;
              }
              try {
                const { matchFieldsWithAI } = await import('../core/aiEngine');
                const mappings = await matchFieldsWithAI(settings, parsedFields, formFields, dataUrl);
                sendResponse({ mappings });
              } catch (err: any) {
                sendResponse({ error: err.message, mappings: [] });
              }
            });
          }
        });
        return true;
      }

      default:
        return false;
    }
  }
);

console.log('FormSnap background script loaded');
