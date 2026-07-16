import { ParsedField, FormField, MappingResult, ExtensionSettings } from './types';
import { semanticMatch } from './aiEngine';

function normalize(s: string): string {
  return s.toLowerCase().replace(/[\s\-_]/g, '').trim();
}

function exactMatch(source: string, target: string): boolean {
  return normalize(source) === normalize(target);
}

function stringSimilarity(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.9;

  // Simple Jaccard on character bigrams
  const bigrams = (s: string) => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ba = bigrams(na);
  const bb = bigrams(nb);
  let intersection = 0;
  ba.forEach((b) => { if (bb.has(b)) intersection++; });
  const union = ba.size + bb.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export async function matchFields(
  sourceFields: ParsedField[],
  targetFields: FormField[],
  settings: ExtensionSettings,
  useAI: boolean = true
): Promise<MappingResult[]> {
  const results: MappingResult[] = [];
  const usedTargets = new Set<string>();

  for (const source of sourceFields) {
    let bestMatch: FormField | null = null;
    let bestConfidence = 0;
    let bestMethod = '';

    // Round 1: Exact match
    for (const target of targetFields) {
      if (usedTargets.has(target.selector)) continue;
      if (exactMatch(source.field, target.label) || exactMatch(source.field, target.name || '')) {
        bestMatch = target;
        bestConfidence = 1.0;
        bestMethod = 'exact';
        break;
      }
    }

    // Round 2: String similarity
    if (!bestMatch) {
      for (const target of targetFields) {
        if (usedTargets.has(target.selector)) continue;
        const sim = Math.max(
          stringSimilarity(source.field, target.label),
          stringSimilarity(source.field, target.name || ''),
          stringSimilarity(source.value, target.label)
        );
        if (sim > bestConfidence) {
          bestConfidence = sim;
          bestMatch = target;
          bestMethod = 'string';
        }
      }
    }

    // Round 3: AI semantic match (only for unmatched fields)
    if (!bestMatch || bestConfidence < settings.confidenceThreshold) {
      if (useAI && settings.apiKey && sourceFields.length > 0 && targetFields.length > 0) {
        try {
          // 找出还没匹配上的
          const unmatchedSource = sourceFields.filter(
            (s) => !results.some((r) => r.sourceField.field === s.field && r.confidence >= settings.confidenceThreshold)
          );
          const unmatchedTarget = targetFields.filter((t) => !usedTargets.has(t.selector));

          if (unmatchedSource.includes(source) && unmatchedTarget.length > 0) {
            // 只在第一次遇到未匹配时批量调用AI
            const aiResults = await semanticMatch(settings, unmatchedSource, unmatchedTarget);
            for (const ai of aiResults) {
              const src = unmatchedSource.find((s) => s.field === ai.source);
              const tgt = unmatchedTarget.find((t) => t.label === ai.target);
              if (src && tgt && ai.confidence > bestConfidence && !usedTargets.has(tgt.selector)) {
                bestMatch = tgt;
                bestConfidence = ai.confidence;
                bestMethod = 'semantic';
              }
            }
          }
        } catch (err) {
          console.warn('AI semantic match failed:', err);
        }
      }
    }

    if (bestMatch) {
      usedTargets.add(bestMatch.selector);
      let status: MappingResult['status'];
      if (bestConfidence >= settings.confidenceThreshold) {
        status = 'auto';
      } else if (bestConfidence >= settings.confirmThreshold) {
        status = 'confirm';
      } else {
        status = 'unmatched';
      }
      results.push({
        sourceField: source,
        targetField: bestMatch,
        confidence: Math.round(bestConfidence * 100) / 100,
        status,
        userConfirmed: status === 'auto',
      });
    } else {
      results.push({
        sourceField: source,
        targetField: { selector: '', label: '(未匹配)', type: source.type },
        confidence: 0,
        status: 'unmatched',
        userConfirmed: false,
      });
    }
  }

  return results;
}
