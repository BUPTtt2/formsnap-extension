import { ParsedField, FieldType } from '../core/types';

// 动态导入 xlsx
async function getXlsx() {
  const XLSX = await import('xlsx');
  return XLSX.default || XLSX;
}

function inferFieldType(value: string): FieldType {
  if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(value)) return 'date';
  if (/^\d+$/.test(value)) return 'number';
  if (['是', '否', 'true', 'false', 'yes', 'no'].includes(value.toLowerCase())) return 'checkbox';
  return 'text';
}

export async function parseCSV(text: string): Promise<ParsedField[]> {
  const lines = text.trim().split('\n').filter((l) => l.trim());
  if (lines.length < 2) return [];

  // Auto-detect delimiter
  const firstLine = lines[0];
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(',') ? ',' : '|';

  const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^["']|["']$/g, ''));
  const fields: ParsedField[] = [];

  for (let i = 1; i < lines.length; i++) {
    const values = lines[i].split(delimiter).map((v) => v.trim().replace(/^["']|["']$/g, ''));
    headers.forEach((header, j) => {
      if (header && values[j]) {
        fields.push({
          field: header,
          value: values[j],
          type: inferFieldType(values[j]),
        });
      }
    });
  }

  return fields;
}

export async function parseExcel(file: File): Promise<ParsedField[]> {
  const XLSX = await getXlsx();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });

  const fields: ParsedField[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<{ [key: string]: any }>(sheet, { defval: '' });

    for (const row of data) {
      for (const [key, value] of Object.entries(row)) {
        if (key && value !== undefined && value !== null && String(value).trim()) {
          fields.push({
            field: String(key).trim(),
            value: String(value).trim(),
            type: inferFieldType(String(value)),
          });
        }
      }
    }
  }

  return fields;
}

export async function parseFile(file: File): Promise<ParsedField[]> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.csv') || name.endsWith('.tsv') || name.endsWith('.txt')) {
    const text = await file.text();
    return parseCSV(text);
  }
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return parseExcel(file);
  }
  throw new Error(`不支持的文件格式: ${name}`);
}
