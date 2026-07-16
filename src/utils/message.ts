import { FormSnapMessage, MessageType } from '../core/types';

type MessageHandler = (message: FormSnapMessage, sender: chrome.runtime.MessageSender) => any;

export function sendMessage<T = any>(type: MessageType, payload?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as T);
      }
    });
  });
}

export function sendMessageToTab<T = any>(tabId: number, type: MessageType, payload?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type, payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response as T);
      }
    });
  });
}

export function onMessage(handler: MessageHandler): void {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const result = handler(message, sender);
    if (result instanceof Promise) {
      result.then(sendResponse).catch((err) => {
        sendResponse({ error: err.message });
      });
      return true; // 异步响应
    }
    sendResponse(result);
  });
}

export async function getCurrentTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab;
}
