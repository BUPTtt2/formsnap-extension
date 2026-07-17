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

      default:
        return false;
    }
  }
);

console.log('FormSnap background script loaded');
