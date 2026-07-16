import { FormSnapMessage } from './contentTypes';
import { scanPageForms, detectNewButtons, clickNewButton, waitForFormFields, detectCanvasSpreadsheet } from './formScanner';
import { executeFillMappingsWithUndo, undoFill, fillCanvasSpreadsheet } from './formFiller';
// Import agent scanner to register its message listeners in the content script bundle
import './agentScanner';

chrome.runtime.onMessage.addListener(
  (message: FormSnapMessage, sender, sendResponse) => {
    switch (message.type) {
      case 'SCAN_FORM': {
        try {
          const fields = scanPageForms();
          if (!Array.isArray(fields)) {
            sendResponse({ error: 'scanPageForms returned invalid result', fields: [], url: window.location.href, title: document.title });
            return false;
          }
          // Detect Canvas spreadsheets (e.g. SpreadJS)
          const canvasInfo = detectCanvasSpreadsheet();
          const newButtons = (fields.length === 0 && !canvasInfo.detected) ? detectNewButtons() : undefined;
          sendResponse({
            fields,
            newButtons,
            canvasInfo,
            url: window.location.href,
            title: document.title,
          });
        } catch (err: any) {
          sendResponse({ error: err.message, fields: [], url: window.location.href, title: document.title });
        }
        return false; // sync response
      }

      case 'FILL_FORM': {
        try {
          if (!message.payload || !message.payload.mappings || !Array.isArray(message.payload.mappings)) {
            sendResponse({ items: [], total: 0, success: 0, failed: 0, error: 'Invalid payload: mappings required' });
            return false;
          }
          const { mappings } = message.payload;
          if (mappings.length === 0) {
            sendResponse({ items: [], total: 0, success: 0, failed: 0, error: 'No mappings to fill' });
            return false;
          }
          const result = executeFillMappingsWithUndo(mappings);
          sendResponse(result);
        } catch (err: any) {
          sendResponse({ items: [], total: 0, success: 0, failed: 0, error: err.message });
        }
        return false;
      }

      case 'FILL_CANVAS': {
        try {
          if (!message.payload || !message.payload.mappings || !Array.isArray(message.payload.mappings)) {
            sendResponse({ items: [], total: 0, success: 0, failed: 0, error: 'Invalid payload' });
            return false;
          }
          const result = fillCanvasSpreadsheet(message.payload);
          sendResponse(result);
        } catch (err: any) {
          sendResponse({ items: [], total: 0, success: 0, failed: 0, error: err.message });
        }
        return false;
      }

      case 'CLICK_NEW_BUTTON': {
        try {
          const { selector } = message.payload || {};
          if (!selector) {
            sendResponse({ success: false, error: 'No selector provided' });
            return false;
          }
          const clicked = clickNewButton(selector);
          if (!clicked) {
            sendResponse({ success: false, error: 'Button not found' });
            return false;
          }
          // Wait a bit for form fields to appear
          waitForFormFields(3000).then((fields) => {
            sendResponse({
              success: true,
              fields,
              newButtons: fields.length === 0 ? detectNewButtons() : undefined,
              url: window.location.href,
              title: document.title,
            });
          });
          return true; // async response
        } catch (err: any) {
          sendResponse({ success: false, error: err.message });
          return false;
        }
      }

      case 'UNDO_FILL': {
        try {
          const result = undoFill();
          sendResponse(result);
        } catch (err: any) {
          sendResponse({ total: 0, success: 0, error: err.message });
        }
        return false;
      }

      default:
        return false;
    }
  }
);

console.log('FormSnap content script loaded');
