import React, { useState, useEffect } from 'react';
import { ExtensionSettings, DEFAULT_SETTINGS, MappingHistoryEntry, MappingResult, ParsedField } from '../core/types';
import { sendMessage } from '../utils/message';

interface Preset {
  name: string;
  endpoint: string;
  model: string;
  visionModel: string;  // 新增
  keyHint: string;
  keyUrl: string;
}

const PRESETS: Preset[] = [
  {
    name: 'OpenAI GPT-4o',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o',
    visionModel: 'gpt-4o',
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com',
  },
  {
    name: '智谱 GLM-4-Flash（免费·文本）',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    visionModel: 'glm-4v-flash',
    keyHint: '从 open.bigmodel.cn 获取',
    keyUrl: 'https://open.bigmodel.cn',
  },
  {
    name: '智谱 GLM-4V-Flash（免费·视觉）',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4v-flash',
    visionModel: 'glm-4v-flash',
    keyHint: '从 open.bigmodel.cn 获取（截图识别必选此模型）',
    keyUrl: 'https://open.bigmodel.cn',
  },
  {
    name: '硅基流动 (SiliconFlow)',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'deepseek-ai/DeepSeek-V3',
    visionModel: 'Pro/Qwen/Qwen2.5-VL-7B-Instruct',
    keyHint: '从 cloud.siliconflow.cn 获取',
    keyUrl: 'https://cloud.siliconflow.cn',
  },
  {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/chat/completions',
    model: 'deepseek-chat',
    visionModel: 'deepseek-chat',
    keyHint: '从 platform.deepseek.com 获取',
    keyUrl: 'https://platform.deepseek.com',
  },
  {
    name: '阿里云百炼 (通义千问)',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-turbo',
    visionModel: 'qwen-vl-max',
    keyHint: '从 bailian.console.aliyun.com 获取',
    keyUrl: 'https://bailian.console.aliyun.com',
  },
  {
    name: '自定义 API',
    endpoint: '',
    model: '',
    visionModel: '',
    keyHint: '输入你的 API Key',
    keyUrl: '',
  },
];

export default function Options() {
  const [settings, setSettings] = useState<ExtensionSettings>({ ...DEFAULT_SETTINGS });
  const [showKey, setShowKey] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedPreset, setSelectedPreset] = useState(0);
  const [activeTab, setActiveTab] = useState<'settings' | 'history'>('settings');
  const [history, setHistory] = useState<MappingHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null); // "entryIdx-mapIdx"
  const [editValue, setEditValue] = useState('');
  const [showAddForm, setShowAddForm] = useState<number | null>(null); // entry index
  const [addField, setAddField] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addTarget, setAddTarget] = useState('');

  useEffect(() => {
    sendMessage<ExtensionSettings>('GET_SETTINGS')
      .then((s) => {
        setSettings(s);
        // Try to match preset
        const idx = PRESETS.findIndex((p) => p.endpoint === s.apiEndpoint && p.model === s.apiModel);
        if (idx >= 0) setSelectedPreset(idx);
        else if (s.apiEndpoint) setSelectedPreset(PRESETS.length - 1); // custom
      })
      .catch(() => setStatus({ type: 'error', text: '加载设置失败' }))
      .finally(() => setLoading(false));
  }, []);

  const applyPreset = (idx: number) => {
    setSelectedPreset(idx);
    const preset = PRESETS[idx];
    if (idx < PRESETS.length - 1) {
      setSettings((prev) => ({
        ...prev,
        apiEndpoint: preset.endpoint,
        apiModel: preset.model,
        apiVisionModel: preset.visionModel,
      }));
    }
  };

  const handleSave = async () => {
    try {
      await sendMessage('SAVE_SETTINGS', settings);
      setStatus({ type: 'success', text: '设置已保存' });
      setTimeout(() => setStatus(null), 3000);
    } catch (err: any) {
      setStatus({ type: 'error', text: '保存失败: ' + err.message });
    }
  };

  const handleReset = () => {
    setSettings({ ...DEFAULT_SETTINGS });
    setSelectedPreset(0);
    setShowKey(false);
  };

  const loadHistory = async () => {
    setHistoryLoading(true);
    try {
      // Get all keys from storage that match mapping_history_*
      const result = await new Promise<{ [key: string]: any }>((resolve) => {
        chrome.storage.local.get(null, resolve);
      });
      const entries: MappingHistoryEntry[] = [];
      for (const key of Object.keys(result)) {
        if (key.startsWith('mapping_history_') && result[key]) {
          entries.push(result[key] as MappingHistoryEntry);
        }
      }
      // Sort by timestamp descending
      entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      setHistory(entries.slice(0, 50)); // Max 50
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  };

  const handleClearHistory = async () => {
    if (!confirm('确定要清除所有填写历史记录吗？')) return;
    try {
      const result = await new Promise<{ [key: string]: any }>((resolve) => {
        chrome.storage.local.get(null, resolve);
      });
      const keysToRemove = Object.keys(result).filter((k) => k.startsWith('mapping_history_'));
      await chrome.storage.local.remove(keysToRemove);
      setHistory([]);
    } catch {}
  };

  const handleReuse = async (entry: MappingHistoryEntry) => {
    try {
      await chrome.storage.local.set({
        pending_reuse_mappings: entry.mappings,
        pending_reuse_url: entry.urlPattern,
      });
      setStatus({ type: 'success', text: '已加载历史映射，请在目标页面打开 FormSnap 面板使用' });
      setTimeout(() => setStatus(null), 4000);
    } catch {
      setStatus({ type: 'error', text: '加载失败' });
    }
  };

  const handleCopyRecord = (entry: MappingHistoryEntry, format: 'tsv' | 'kv' | 'json' = 'tsv') => {
    let text = '';
    if (format === 'tsv') {
      // TSV: header row + value row, directly pastable to Excel/spreadsheet
      const headers = entry.mappings.map((m) => m.sourceField.field).join('\t');
      const values = entry.mappings.map((m) => m.sourceField.value || '').join('\t');
      text = `${headers}\n${values}`;
    } else if (format === 'json') {
      const obj: Record<string, string> = {};
      entry.mappings.forEach((m) => { obj[m.sourceField.field] = m.sourceField.value || ''; });
      text = JSON.stringify(obj, null, 2);
    } else {
      const lines = entry.mappings.map((m) => `${m.sourceField.field}: ${m.sourceField.value || ''} → ${m.targetField.label}`);
      text = lines.join('\n');
    }
    navigator.clipboard.writeText(text).then(() => {
      setStatus({ type: 'success', text: `已复制 (${format === 'tsv' ? '表格格式' : format === 'json' ? 'JSON' : '文本'})` });
      setTimeout(() => setStatus(null), 2000);
    });
  };

  const handleDeleteMapping = async (entryIndex: number, mappingIndex: number) => {
    const entry = history[entryIndex];
    if (!entry) return;
    const newMappings = entry.mappings.filter((_, i) => i !== mappingIndex);
    await updateEntryMappings(entryIndex, newMappings);
  };

  const updateEntryMappings = async (entryIndex: number, newMappings: MappingResult[]) => {
    const entry = history[entryIndex];
    if (!entry) return;
    const result = await new Promise<{ [key: string]: any }>((resolve) => {
      chrome.storage.local.get(null, resolve);
    });
    const keys = Object.keys(result).filter((k) => k.startsWith('mapping_history_'));
    const key = keys.find((k) => result[k].timestamp === entry.timestamp);
    if (key) {
      await chrome.storage.local.set({ [key]: { ...entry, mappings: newMappings } });
      const updated = [...history];
      updated[entryIndex] = { ...entry, mappings: newMappings };
      setHistory(updated);
    }
  };

  const startEdit = (entryIdx: number, mapIdx: number, currentValue: string) => {
    setEditingKey(`${entryIdx}-${mapIdx}`);
    setEditValue(currentValue);
  };

  const saveEdit = async (entryIdx: number, mapIdx: number) => {
    const entry = history[entryIdx];
    if (!entry) return;
    const newMappings = entry.mappings.map((m, i) =>
      i === mapIdx ? { ...m, sourceField: { ...m.sourceField, value: editValue } } : m
    );
    await updateEntryMappings(entryIdx, newMappings);
    setEditingKey(null);
    setEditValue('');
  };

  const handleAddMapping = async (entryIdx: number) => {
    if (!addField.trim() || !addTarget.trim()) return;
    const entry = history[entryIdx];
    if (!entry) return;
    const newMapping: MappingResult = {
      sourceField: { field: addField.trim(), value: addValue.trim(), type: 'text', confidence: 1 } as ParsedField,
      targetField: { selector: addTarget.trim(), label: addTarget.trim(), type: 'text' },
      confidence: 1,
      status: 'auto',
      userConfirmed: true,
    };
    await updateEntryMappings(entryIdx, [...entry.mappings, newMapping]);
    setAddField('');
    setAddValue('');
    setAddTarget('');
    setShowAddForm(null);
  };

  const preset = PRESETS[selectedPreset];
  const isCustom = selectedPreset === PRESETS.length - 1;

  if (loading) return <div className="container"><p>加载中...</p></div>;

  return (
    <div className="container">
      {/* Tab bar */}
      <div className="tab-bar">
        <button
          className={`tab-btn ${activeTab === 'settings' ? 'active' : ''}`}
          onClick={() => { setActiveTab('settings'); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          模型设置
        </button>
        <button
          className={`tab-btn ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => { setActiveTab('history'); if (history.length === 0) loadHistory(); }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          填写历史
        </button>
      </div>

      {/* Settings tab */}
      {activeTab === 'settings' && (
      <div className="card">
        <h1><span>FormSnap</span> 设置</h1>
        <p className="subtitle">配置 AI 模型和填写参数</p>

        <h2>AI 模型配置</h2>

        <div className="form-group">
          <label>选择 API 提供商</label>
          <select value={selectedPreset} onChange={(e) => applyPreset(Number(e.target.value))}>
            {PRESETS.map((p, i) => (
              <option key={i} value={i}>{p.name}</option>
            ))}
          </select>
          <p className="hint">
            {isCustom ? '自定义 OpenAI 兼容 API 端点' : `${preset.model} @ ${preset.endpoint}`}
          </p>
        </div>

        {isCustom && (
          <>
            <div className="form-group">
              <label>API 端点 (Endpoint)</label>
              <input
                type="text"
                value={settings.apiEndpoint}
                onChange={(e) => setSettings({ ...settings, apiEndpoint: e.target.value })}
                placeholder="https://api.example.com/v1/chat/completions"
              />
            </div>
            <div className="form-group">
              <label>模型名称 (Model)</label>
              <input
                type="text"
                value={settings.apiModel}
                onChange={(e) => setSettings({ ...settings, apiModel: e.target.value })}
                placeholder="model-name"
              />
            </div>
            <div className="form-group">
              <label>视觉模型名称 (Vision Model)</label>
              <input
                type="text"
                value={settings.apiVisionModel}
                onChange={(e) => setSettings({ ...settings, apiVisionModel: e.target.value })}
                placeholder="用于截图识别的模型"
              />
              <p className="hint">截图识别会使用此模型，文本解析使用上面的文本模型</p>
            </div>
          </>
        )}

        <div className="form-group">
          <label>API Key</label>
          <div className="api-key-row">
            <input
              type={showKey ? 'text' : 'password'}
              value={settings.apiKey}
              onChange={(e) => setSettings({ ...settings, apiKey: e.target.value })}
              placeholder={preset.keyHint}
            />
            <button className="toggle-vis" onClick={() => setShowKey(!showKey)} title={showKey ? '隐藏' : '显示'}>
              {showKey ? (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              )}
            </button>
          </div>
          {preset.keyUrl && (
            <p className="hint">
              从 <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>{preset.keyUrl}</a> 获取
            </p>
          )}
        </div>

        <div className="callout">
          <strong>提示：</strong>纯文本输入模式下，若未配置 API Key，会自动使用本地解析（支持键值对、表格等格式），无需消耗任何 API 额度。
        </div>

        <h2>填写参数</h2>

        <div className="form-group">
          <label>自动填写阈值（置信度）</label>
          <div className="range-row">
            <input
              type="range"
              min="0.5"
              max="1.0"
              step="0.05"
              value={settings.confidenceThreshold}
              onChange={(e) => setSettings({ ...settings, confidenceThreshold: parseFloat(e.target.value) })}
            />
            <span className="range-value">{(settings.confidenceThreshold * 100).toFixed(0)}%</span>
          </div>
          <p className="hint">高于此值的匹配将自动填写，无需确认</p>
        </div>

        <div className="form-group">
          <label>确认阈值（置信度）</label>
          <div className="range-row">
            <input
              type="range"
              min="0.3"
              max="0.95"
              step="0.05"
              value={settings.confirmThreshold}
              onChange={(e) => setSettings({ ...settings, confirmThreshold: parseFloat(e.target.value) })}
            />
            <span className="range-value">{(settings.confirmThreshold * 100).toFixed(0)}%</span>
          </div>
          <p className="hint">低于此值的匹配将标记为未匹配</p>
        </div>

        <div className="action-row">
          <button className="btn btn-primary" onClick={handleSave}>
            保存设置
          </button>
          <button className="btn btn-outline" onClick={handleReset}>
            恢复默认
          </button>
        </div>

        {status && <div className={`status-msg ${status.type}`}>{status.text}</div>}
      </div>
      )}

      {/* History tab */}
      {activeTab === 'history' && (
        <div className="card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h1>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style={{ display: 'inline', verticalAlign: 'text-bottom', marginRight: 6 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              填写历史
            </h1>
            {history.length > 0 && (
              <button className="btn btn-ghost" onClick={handleClearHistory}>
                清除全部
              </button>
            )}
          </div>

          {historyLoading && <p style={{ color: 'var(--ink-500)' }}>加载中...</p>}

          {!historyLoading && history.length === 0 && (
            <div className="history-empty">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style={{ marginBottom: 12, opacity: 0.4 }}>
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>
              </svg>
              <p>还没有填写记录</p>
              <p style={{ fontSize: 12, marginTop: 4 }}>使用 FormSnap 填写表单后，记录会自动保存在这里</p>
            </div>
          )}

          {!historyLoading && history.length > 0 && (
            <div style={{ maxHeight: 520, overflow: 'auto' }}>
              {history.map((entry, i) => (
                <div key={i} className="history-item">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-700)' }}>
                      {entry.urlPattern || '未知页面'}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--ink-400)' }}>
                      {entry.timestamp ? new Date(entry.timestamp).toLocaleString('zh-CN') : ''}
                    </span>
                  </div>

                  {/* Action buttons */}
                  <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => handleReuse(entry)}>
                      复用映射
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => handleCopyRecord(entry, 'tsv')}>
                      复制表格
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => handleCopyRecord(entry, 'json')}>
                      复制JSON
                    </button>
                    <button className="btn btn-ghost" style={{ fontSize: 12, padding: '4px 10px' }} onClick={() => setExpandedIndex(expandedIndex === i ? null : i)}>
                      {expandedIndex === i ? '收起' : `展开 (${entry.mappings.length} 项)`}
                    </button>
                  </div>

                  {entry.mappings && entry.mappings.length > 0 && expandedIndex !== i && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                      {entry.mappings.slice(0, 6).map((m, j) => (
                        <span key={j} className="history-tag accent">
                          {m.targetField?.label || m.sourceField?.field || '?'} = {m.sourceField?.value || ''}
                        </span>
                      ))}
                      {entry.mappings.length > 6 && (
                        <span style={{ padding: '3px 10px', color: 'var(--ink-400)', fontSize: 11 }}>
                          +{entry.mappings.length - 6} 项
                        </span>
                      )}
                    </div>
                  )}

                  {/* Expanded detail */}
                  {expandedIndex === i && (
                    <div style={{ marginTop: 8, borderTop: '1px solid var(--ink-100)', paddingTop: 8 }}>
                      {entry.mappings.map((m, j) => {
                        const editKey = `${i}-${j}`;
                        const isEditing = editingKey === editKey;
                        return (
                          <div key={j} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '5px 0', borderBottom: '1px dashed var(--ink-100)', fontSize: 13 }}>
                            <div style={{ display: 'flex', gap: 10, flex: 1, minWidth: 0, alignItems: 'center' }}>
                              <span style={{ color: 'var(--accent)', fontWeight: 500, minWidth: 60, fontSize: 12 }}>{m.sourceField.field}</span>
                              {isEditing ? (
                                <input
                                  value={editValue}
                                  onChange={(e) => setEditValue(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter') saveEdit(i, j); if (e.key === 'Escape') { setEditingKey(null); setEditValue(''); } }}
                                  style={{ padding: '3px 8px', borderRadius: 4, border: '1px solid var(--accent)', fontSize: 12, width: 120, fontFamily: 'monospace' }}
                                  autoFocus
                                />
                              ) : (
                                <span
                                  className="editable-value"
                                  onClick={() => startEdit(i, j, m.sourceField.value || '')}
                                  title="点击编辑"
                                >
                                  {m.sourceField.value || '(空)'}
                                </span>
                              )}
                              <span style={{ color: 'var(--ink-300)' }}>→</span>
                              <span style={{ color: 'var(--ink-700)' }}>{m.targetField.label}</span>
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginLeft: 8 }}>
                              {isEditing && (
                                <button className="btn btn-ghost" style={{ fontSize: 11, padding: '2px 8px', color: 'var(--accent)' }} onClick={() => saveEdit(i, j)}>
                                  保存
                                </button>
                              )}
                              <button
                                className="btn btn-ghost"
                                style={{ fontSize: 11, padding: '2px 8px', color: '#991B1B' }}
                                onClick={() => handleDeleteMapping(i, j)}
                              >
                                删除
                              </button>
                            </div>
                          </div>
                        );
                      })}

                      {/* Add new mapping */}
                      <div style={{ marginTop: 10 }}>
                        {showAddForm === i ? (
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '10px 0' }}>
                            <input placeholder="字段名" value={addField} onChange={(e) => setAddField(e.target.value)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--ink-200)', fontSize: 12, width: 90 }} />
                            <input placeholder="值" value={addValue} onChange={(e) => setAddValue(e.target.value)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--ink-200)', fontSize: 12, width: 90 }} />
                            <input placeholder="目标列" value={addTarget} onChange={(e) => setAddTarget(e.target.value)} style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--ink-200)', fontSize: 12, width: 90 }} />
                            <button className="btn btn-primary" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => handleAddMapping(i)} disabled={!addField.trim() || !addTarget.trim()}>
                              添加
                            </button>
                            <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px' }} onClick={() => { setShowAddForm(null); setAddField(''); setAddValue(''); setAddTarget(''); }}>
                              取消
                            </button>
                          </div>
                        ) : (
                          <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 12px', marginTop: 4 }} onClick={() => setShowAddForm(i)}>
                            + 添加映射
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
