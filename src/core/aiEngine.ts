import { ParsedField, ExtensionSettings } from './types';

function buildParsePrompt(): string {
  return `你是一个表单数据提取助手。用户会提供一段文本或一张截图，里面包含字段名和对应的值。
请提取所有字段，返回严格的 JSON 数组格式。

规则：
1. 每个字段包含 field（字段名）、value（值）、type（字段类型）
2. type 可能的值：text（文本）、select（下拉选择）、radio（单选）、checkbox（复选框）、date（日期）、number（数字）
3. 如果字段名和值的关系不明显，尽量从上下文推断
4. **不要遗漏任何字段！仔细检查每个可见的字段**
5. 只返回 JSON 数组，不要其他文字
6. 数值类型请完整保留，不要截断小数位

示例输出：
[
  {"field": "名称", "value": "张三", "type": "text"},
  {"field": "类型", "value": "选项A", "type": "select"}
]

请提取以下内容中的所有字段和值：`;
}

function buildMatchPrompt(sourceFields: string[], targetFields: string[]): string {
  return `你是一个字段匹配助手。我需要把数据源的字段映射到目标表单的字段上。

数据源字段：
${sourceFields.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}

目标表单字段：
${targetFields.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}

请为每个数据源字段找到最佳匹配的目标字段，返回 JSON 数组。每个元素：
{
  "source": "数据源字段名",
  "target": "目标字段名",
  "confidence": 0.95,
  "reason": "匹配理由"
}

confidence 是匹配置信度，0到1之间。完全一致为1.0，语义相近为0.8-0.95，勉强相关为0.5-0.8。
只返回 JSON 数组，不要其他文字。`;
}

function validateEndpoint(endpoint: string): void {
  if (!endpoint || typeof endpoint !== 'string') {
    throw new Error('API 端点地址无效');
  }
  try {
    const url = new URL(endpoint);
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('API 端点仅支持 HTTP/HTTPS 协议');
    }
    if (!url.hostname) {
      throw new Error('API 端点地址格式错误，缺少主机名');
    }
  } catch (e: any) {
    if (e.message?.includes('API 端点')) throw e;
    throw new Error('API 端点地址格式错误，请输入有效的 URL（如 https://api.openai.com/v1/chat/completions）');
  }
}

async function callOpenAICompatible(
  endpoint: string,
  apiKey: string,
  model: string,
  images: string[],  // 支持多张图片
  textPrompt: string
): Promise<string> {
  validateEndpoint(endpoint);

  const messages: any[] = [
    { role: 'system', content: '你是一个专业的数据提取助手。只返回JSON，不要其他文字。' },
  ];

  if (images && images.length > 0) {
    const content: any[] = [{ type: 'text', text: textPrompt }];
    for (const img of images) {
      content.push({ type: 'image_url', image_url: { url: img } });
    }
    messages.push({ role: 'user', content });
  } else {
    messages.push({ role: 'user', content: textPrompt });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

  // Strategy: try with 1024 first, if max_tokens error, retry with 512
  const maxTokensValues = [1024, 512];
  let lastError: Error | null = null;

  for (const maxTokens of maxTokensValues) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: maxTokens,
          temperature: 0.1,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        // Try to parse structured error for friendly messages
        let friendly = '';
        let parsedError: any = null;
        try { parsedError = JSON.parse(errText); } catch {}

        switch (response.status) {
          case 400: {
            // If max_tokens error, try smaller value
            const isMaxTokensError = parsedError?.error?.code === 1210
              || (parsedError?.error?.message && parsedError.error.message.includes('max_tokens'));
            if (isMaxTokensError && maxTokens > 512) {
              continue; // Try next smaller value
            }
            if (isMaxTokensError) {
              friendly = 'AI 模型不支持该参数，请检查模型设置或切换模型';
            } else {
              friendly = '请求参数有误，请检查模型设置或更换模型';
            }
            break;
          }
          case 401:
            friendly = 'API Key 无效或已过期，请检查设置中的 API Key';
            break;
          case 403:
            friendly = '没有权限访问该模型，请确认模型名称正确或更换模型';
            break;
          case 429:
            friendly = '请求过于频繁，请等待几秒后重试（API 限流）';
            break;
          case 500:
          case 502:
          case 503:
            friendly = '模型服务暂时不可用，请稍后重试';
            break;
          default:
            friendly = `API 错误 ${response.status}：${response.statusText}`;
        }
        // Show friendly message to user, include detail only if it's useful
        const detail = parsedError?.error?.message || '';
        throw new Error(`${friendly}${detail ? `（${detail.slice(0, 100)}）` : ''}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content || !content.trim()) {
        throw new Error('AI 返回了空内容，请检查模型配置或重试');
      }
      return content;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('请求超时（30秒），请检查网络连接或重试');
      }
      lastError = err;
      // If it's a max_tokens error that we'll retry with smaller value, continue
      if (err.message?.includes('max_tokens') || err.message?.includes('1210')) {
        continue;
      }
      throw err; // For all other errors, throw immediately
    }
  }

  throw lastError || new Error('请求失败');
}

function parseJSONResponse(raw: string): any[] {
  let cleaned = raw.trim();
  if (!cleaned) throw new Error('AI 返回内容为空');

  // Step 1: Extract from code blocks if present
  const codeBlockMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) cleaned = codeBlockMatch[1].trim();

  // Step 2: Find the JSON array - use a balanced bracket approach
  // Find the first '[' and then track nesting to find the matching ']'
  const firstBracket = cleaned.indexOf('[');
  if (firstBracket === -1) throw new Error('AI 返回内容中未找到 JSON 数组');

  let depth = 0;
  let endIdx = -1;
  let inString = false;
  let escape = false;

  for (let i = firstBracket; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"' && !escape) { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }

  if (endIdx === -1) throw new Error('AI 返回的 JSON 数组不完整');

  let jsonStr = cleaned.slice(firstBracket, endIdx + 1);

  // Step 3: Try parsing directly
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) throw new Error('AI 返回的不是数组格式');
    return parsed;
  } catch (e: any) {
    // Step 4: Try fixing common AI output issues
    // Remove trailing commas before ] or }
    jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
    // Fix single quotes to double quotes (non-standard but some models do this)
    // Only outside of double-quoted strings
    try {
      const parsed = JSON.parse(jsonStr);
      if (!Array.isArray(parsed)) throw new Error('AI 返回的不是数组格式');
      return parsed;
    } catch (e2: any) {
      throw new Error(`AI 返回的 JSON 解析失败: ${e2.message}。请重试或检查输入内容`);
    }
  }
}

export async function parseDataSource(
  settings: ExtensionSettings,
  input: { images?: string[] | null; text?: string }
): Promise<ParsedField[]> {
  let raw: string;

  if (!settings.apiKey) {
    throw new Error('未配置 API Key，请在设置页配置');
  }

  if (input.images && input.images.length > 0) {
    raw = await callOpenAICompatible(settings.apiEndpoint, settings.apiKey, settings.apiVisionModel || settings.apiModel, input.images, buildParsePrompt());
  } else if (input.text) {
    const fullPrompt = buildParsePrompt() + '\n\n' + input.text;
    raw = await callOpenAICompatible(settings.apiEndpoint, settings.apiKey, settings.apiModel, [], fullPrompt);
  } else {
    throw new Error('No input provided');
  }

  const parsed = parseJSONResponse(raw);
  return parsed.map((item: any) => ({
    field: String(item.field || item.name || ''),
    value: String(item.value || ''),
    type: item.type || 'text',
    confidence: item.confidence || 1.0,
  }));
}

export async function semanticMatch(
  settings: ExtensionSettings,
  sourceFields: ParsedField[],
  targetFields: { label: string; selector: string; type: string }[]
): Promise<Array<{ source: string; target: string; confidence: number; reason: string }>> {
  const sourceNames = sourceFields.map((f) => f.field);
  const targetNames = targetFields.map((f) => f.label);
  const prompt = buildMatchPrompt(sourceNames, targetNames);
  const raw = await callOpenAICompatible(settings.apiEndpoint, settings.apiKey, settings.apiModel, [], prompt);
  return parseJSONResponse(raw);
}

/**
 * AI-powered visual matching: send page screenshot + parsed data fields to AI.
 * AI looks at the screenshot to understand the page layout and returns
 * which data field should map to which DOM element's selector.
 */
export async function matchFieldsWithAI(
  settings: ExtensionSettings,
  parsedFields: { field: string; value: string; type: string }[],
  formFields: { label: string; selector: string; type: string; placeholder?: string }[],
  pageScreenshot: string
): Promise<Array<{ sourceField: string; targetSelector: string; confidence: number }>> {
  const fieldList = parsedFields.map((f) => `- ${f.field} (值: ${f.value}, 类型: ${f.type})`).join('\n');
  const targetList = formFields.map((f, i) => `  ${i + 1}. 标签: "${f.label || '(空)'}", placeholder: "${f.placeholder || ''}", 类型: ${f.type}, selector: ${f.selector}`).join('\n');

  const prompt = `你是一个智能表单填写助手。请查看当前页面的截图，理解页面上的表单布局。

我有以下数据需要填入页面：
${fieldList}

页面上检测到以下可填写位置：
${targetList}

请根据截图中的视觉布局，判断每个数据字段应该填入页面上的哪个位置（selector）。
只匹配你能确定对应关系的字段，不确定的不要强行匹配。

返回严格的 JSON 数组格式：
[
  {"sourceField": "数据字段名", "targetSelector": "目标元素的selector", "confidence": 0.95}
]

confidence 是匹配置信度 0-1。完全确定对应关系为 1.0，通过上下文推断为 0.8-0.95，猜测为 0.5-0.8。
只返回 JSON 数组，不要其他文字。`;

  const raw = await callOpenAICompatible(settings.apiEndpoint, settings.apiKey, settings.apiModel, [pageScreenshot], prompt);
  return parseJSONResponse(raw);
}
