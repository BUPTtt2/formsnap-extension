import { ParsedField, FieldType } from '../core/types';

function inferType(value: string): FieldType {
  const v = value.trim().toLowerCase();
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}(\s+\d{1,2}:\d{1,2}(:\d{1,2})?)?$/.test(v)) return 'date';
  if (/^\d{4}[-/]\d{1,2}$/.test(v)) return 'date';
  if (/^\d+(\.\d+)?$/.test(v)) return 'number';
  if (['是', '否', 'true', 'false', 'yes', 'no', 'on', 'off', 'checked', 'unchecked'].includes(v)) return 'checkbox';
  return 'text';
}

/**
 * 检测是否为「纯数据行」（无字段名标识，只有值用 Tab 或逗号分隔）
 * 返回按分隔符拆分后的值数组，如果不是则返回 null
 */
function parseRawDataLine(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 尝试 Tab 分隔
  const tabParts = trimmed.split('\t').map(s => s.trim()).filter(Boolean);
  if (tabParts.length >= 2) {
    // 检查是否每段都像值（不是 "字段名: 值" 或 "字段名 = 值" 格式）
    const hasFieldMarker = tabParts.some(p => /^.+\s*[:：=]\s*.+$/.test(p));
    if (!hasFieldMarker) return tabParts;
  }

  // 尝试逗号分隔（至少 3 个值才认为是纯数据行，避免误判）
  const commaParts = trimmed.split(/[,，]/).map(s => s.trim()).filter(Boolean);
  if (commaParts.length >= 3) {
    const hasFieldMarker = commaParts.some(p => /^.+\s*[:：=]\s*.+$/.test(p));
    if (!hasFieldMarker) return commaParts;
  }

  return null;
}

export function parseTextLocal(text: string): ParsedField[] | null {
  const lines = text.trim().split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return null;

  const fields: ParsedField[] = [];
  const seen = new Set<string>();

  // 首先检查是否为纯数据行（Tab/逗号分隔的值，无字段名）
  // 如果所有行都是纯数据行，按列索引生成 field_1, field_2, ...
  let allRawData = true;
  const rawRows: string[][] = [];
  for (const line of lines) {
    const rawParts = parseRawDataLine(line);
    if (rawParts) {
      rawRows.push(rawParts);
    } else {
      allRawData = false;
      break;
    }
  }

  if (allRawData && rawRows.length > 0) {
    // 纯数据行模式：使用第一行确定列数，自动命名
    const colCount = rawRows[0].length;
    // 只取第一行数据（FormSnap 单次填写一行）
    const values = rawRows[0];
    const result: ParsedField[] = [];
    for (let i = 0; i < values.length; i++) {
      result.push({
        field: `列${i + 1}`,
        value: values[i],
        type: inferType(values[i]),
        confidence: 1.0,
      });
    }
    // 如果有多行，追加后续行（以 _rowN 后缀区分）
    for (let r = 1; r < rawRows.length; r++) {
      for (let c = 0; c < rawRows[r].length && c < colCount; c++) {
        result.push({
          field: `列${c + 1}_第${r + 1}行`,
          value: rawRows[r][c],
          type: inferType(rawRows[r][c]),
          confidence: 1.0,
        });
      }
    }
    return result;
  }

  for (const line of lines) {
    // Skip markdown table separators like |---|---|
    if (/^\|?[-:]+\|[-:]+\|/.test(line)) continue;

    let match: RegExpMatchArray | null;

    // Pattern 1: "field: value" or "field：value" (colon separated, common Chinese)
    match = line.match(/^(.+?)[:：]\s*(.+)$/);
    if (match) {
      const field = match[1].trim();
      const value = match[2].trim();
      if (field && value && !seen.has(field)) {
        seen.add(field);
        fields.push({ field, value, type: inferType(value) });
        continue;
      }
    }

    // Pattern 2: "field = value"
    match = line.match(/^(.+?)\s*=\s*(.+)$/);
    if (match) {
      const field = match[1].trim();
      const value = match[2].trim();
      if (field && value && !seen.has(field)) {
        seen.add(field);
        fields.push({ field, value, type: inferType(value) });
        continue;
      }
    }

    // Pattern 3: Markdown table row "| field | value |"
    match = line.match(/^\|(.+?)\|(.+?)\|/);
    if (match) {
      const field = match[1].trim();
      const value = match[2].trim();
      if (field && value && !seen.has(field) && field !== '字段' && field !== 'field' && field !== '名称') {
        seen.add(field);
        fields.push({ field, value, type: inferType(value) });
        continue;
      }
    }

    // Pattern 4: Tab separated
    const tabs = line.split('\t');
    if (tabs.length >= 2) {
      const field = tabs[0].trim();
      const value = tabs[1].trim();
      if (field && value && !seen.has(field)) {
        seen.add(field);
        fields.push({ field, value, type: inferType(value) });
        continue;
      }
    }
  }

  // Also try to parse as markdown table with header row
  if (fields.length < 2) {
    const mdMatch = text.match(/^\|(.+?)\|\n[-:| ]+\n((?:\|.+?\|\n?)+)/m);
    if (mdMatch) {
      const headers = mdMatch[1].split('|').map((h) => h.trim()).filter((h) => h);
      const dataRows = mdMatch[2].trim().split('\n').filter((l) => l.trim());
      for (const row of dataRows) {
        const cells = row.split('|').map((c) => c.trim()).filter((c) => c);
        headers.forEach((header, i) => {
          if (cells[i] && !seen.has(header)) {
            seen.add(header);
            fields.push({ field: header, value: cells[i], type: inferType(cells[i]) });
          }
        });
      }
    }
  }

  return fields.length > 0 ? fields : null;
}
