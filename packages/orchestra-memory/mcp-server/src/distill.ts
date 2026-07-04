// Server-side validation for the memory_save distillation contract.
//
// The LLM calling memory_save is responsible for producing atomic,
// self-contained propositions with canonical entity names (see the tool
// description in tools/save.ts for the full contract). This module is the
// last line of defense against garbage-in: it rejects shapes that cannot
// possibly be atomic/self-contained, and provides the exact-normalized
// dedupe comparison used before inserting a new observation.

export const MAX_FACT_TEXT_LENGTH = 500;

export interface FactEntityInput {
  name: string;
  kind?: string;
}

export interface FactInput {
  entity: FactEntityInput;
  text: string;
  category?: string | null;
  confidence?: 'high' | 'medium' | 'low';
  aliases?: string[];
}

export interface RelationInput {
  src: string;
  predicate: string;
  dst: string;
}

export type FactRejectionReason =
  | 'missing entity name'
  | 'empty or whitespace-only text'
  | `text exceeds ${number} chars (not atomic — split into multiple facts)`;

export interface FactValidationOk {
  ok: true;
}

export interface FactValidationFail {
  ok: false;
  reason: string;
}

export type FactValidationResult = FactValidationOk | FactValidationFail;

/** Rejects fact shapes that cannot be atomic/self-contained observations. */
export function validateFact(fact: FactInput): FactValidationResult {
  const name = fact.entity?.name?.trim();
  if (!name) {
    return { ok: false, reason: 'missing entity name' };
  }
  const text = fact.text?.trim();
  if (!text) {
    return { ok: false, reason: 'empty or whitespace-only text' };
  }
  if (text.length > MAX_FACT_TEXT_LENGTH) {
    return {
      ok: false,
      reason: `text exceeds ${MAX_FACT_TEXT_LENGTH} chars (not atomic — split into multiple facts)`,
    };
  }
  return { ok: true };
}

/**
 * Normalizes observation text for exact-match dedupe comparison: lowercase,
 * trim, collapse internal whitespace. Mirrors the entity canonicalization
 * spec in db/repository.ts's normalize(), applied here to fact *text*
 * instead of entity names.
 */
export function normalizeForDedupe(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}
