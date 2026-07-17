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
        if (!message.payload || !message.payload.urlPattern || !message.payload.mappings) {
          sendResponse({ success: false, error: 'Invalid payload' });
          return false;
        }
        const { urlPattern, mappings } = message.payload;
        // Use timestamp-based unique key for each fill operation
        const key = `mapping_history_${Date.now()}`;
        const entry: MappingHistoryEntry = { urlPattern, mappings, timestamp: Date.now() };
        chrome.storage.local.set({ [key]: entry }, () => {
          // Prune old entries: keep only the latest 50
          chrome.storage.local.get(null, (all) => {
            const historyKeys = Object.keys(all).filter((k) => k.startsWith('mapping_history_')).sort();
            if (historyKeys.length > 50) {
              const toRemove = historyKeys.slice(0, historyKeys.length - 50);
              chrome.storage.local.remove(toRemove);
            }
          });
          sendResponse({ success: true });
        });
        return true;
      }

      case 'GET_MAPPING_HISTORY': {
        if (!message.payload || !message.payload.urlPattern) {
          sendResponse(null);
          return false;
        }
        const { urlPattern } = message.payload;
        const key = `mapping_history_${urlPattern}`;
        chrome.storage.local.get(key, (result) => {
          sendResponse(result[key] || null);
        });
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
