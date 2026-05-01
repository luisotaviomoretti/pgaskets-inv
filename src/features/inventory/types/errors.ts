/**
 * Error code envelope for inventory RPCs.
 *
 * Backend RPCs (migrations 044, 045, 046) RAISE EXCEPTION with a JSON message
 * shaped as `{"code": "...", "detail": "..."}`. The frontend parses it once
 * via `parseRpcError()` and switches on `code`. This replaces the brittle
 * regex chain that previously matched `msg.includes('Insufficient stock')`.
 */

export const InventoryErrorCode = {
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',
  INVALID_INPUT: 'INVALID_INPUT',
  NOT_FOUND: 'NOT_FOUND',
  INTEGRITY_VIOLATION: 'INTEGRITY_VIOLATION',
  DECIMAL_PRECISION: 'DECIMAL_PRECISION',
  DUPLICATE_REQUEST: 'DUPLICATE_REQUEST',
  NETWORK: 'NETWORK',
  UNKNOWN: 'UNKNOWN',
} as const;

export type InventoryErrorCode = typeof InventoryErrorCode[keyof typeof InventoryErrorCode];

export interface ParsedRpcError {
  code: InventoryErrorCode;
  detail: string;
  raw: string;
  /** Optional structured payload for codes like INSUFFICIENT_STOCK. */
  context?: Record<string, unknown>;
}

const KNOWN_CODES: Set<string> = new Set(Object.values(InventoryErrorCode));

function tryParseJson(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function classifyByMessage(msg: string): InventoryErrorCode {
  const lower = msg.toLowerCase();
  if (lower.includes('insufficient stock') || lower.includes('not enough')) {
    return InventoryErrorCode.INSUFFICIENT_STOCK;
  }
  if (lower.includes('not found')) {
    return InventoryErrorCode.NOT_FOUND;
  }
  if (lower.includes('consistent_total') || lower.includes('decimal')) {
    return InventoryErrorCode.DECIMAL_PRECISION;
  }
  if (lower.includes('failed to fetch') || lower.includes('network') || lower.includes('timeout')) {
    return InventoryErrorCode.NETWORK;
  }
  if (lower.includes('check constraint') || lower.includes('violates')) {
    return InventoryErrorCode.INTEGRITY_VIOLATION;
  }
  return InventoryErrorCode.UNKNOWN;
}

/**
 * Parse an RPC error into a stable code + detail. Accepts:
 *  - PostgrestError-shaped objects (`{ message, code, details, hint }`)
 *  - native Errors
 *  - strings
 *  - unknown
 *
 * Pipeline:
 *  1. Coerce to a string message.
 *  2. If the message looks like JSON, parse it and use `code` field if known.
 *  3. Otherwise classify by substring (back-compat for old call sites).
 */
export function parseRpcError(err: unknown): ParsedRpcError {
  if (err == null) {
    return { code: InventoryErrorCode.UNKNOWN, detail: 'Unknown error', raw: '' };
  }

  let message = '';
  let pgCode: string | undefined;
  if (typeof err === 'string') {
    message = err;
  } else if (err instanceof Error) {
    message = err.message;
  } else if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    message = String(e.message ?? e.detail ?? e.details ?? '');
    pgCode = typeof e.code === 'string' ? e.code : undefined;
  } else {
    message = String(err);
  }

  if (pgCode === '23505') {
    return {
      code: InventoryErrorCode.DUPLICATE_REQUEST,
      detail: message || 'Duplicate request',
      raw: message,
    };
  }

  const json = tryParseJson(message);
  if (json) {
    const codeRaw = String(json.code ?? '');
    const code = KNOWN_CODES.has(codeRaw) ? (codeRaw as InventoryErrorCode) : InventoryErrorCode.UNKNOWN;
    const detail = String(json.detail ?? message);
    const { code: _c, detail: _d, ...rest } = json;
    return {
      code,
      detail,
      raw: message,
      context: Object.keys(rest).length > 0 ? rest : undefined,
    };
  }

  return {
    code: classifyByMessage(message),
    detail: message,
    raw: message,
  };
}

/**
 * Map a parsed error to a human-readable message for the UI. Isolated here so
 * we can swap to i18n later without touching call sites.
 */
export function formatUserMessage(parsed: ParsedRpcError): string {
  switch (parsed.code) {
    case InventoryErrorCode.INSUFFICIENT_STOCK: {
      const ctx = parsed.context as { sku_id?: string; available?: number; needed?: number } | undefined;
      if (ctx?.sku_id != null && ctx.available != null && ctx.needed != null) {
        return `Not enough stock for ${ctx.sku_id}: ${ctx.available} available, ${ctx.needed} requested.`;
      }
      return parsed.detail || 'Not enough stock for this work order.';
    }
    case InventoryErrorCode.INVALID_INPUT:
      return parsed.detail || 'Some of the values entered are invalid. Please review the form.';
    case InventoryErrorCode.NOT_FOUND:
      return parsed.detail || 'A referenced item could not be found. The data may have changed — please refresh.';
    case InventoryErrorCode.DECIMAL_PRECISION:
      return 'A decimal precision check failed. Please report this to support so we can investigate.';
    case InventoryErrorCode.INTEGRITY_VIOLATION:
      return 'The database rejected this change because it would violate an integrity rule. Please refresh and try again.';
    case InventoryErrorCode.DUPLICATE_REQUEST:
      return 'This submission was already processed. The previous result is still valid.';
    case InventoryErrorCode.NETWORK:
      return 'Network issue while saving. We may have partially saved — check the Movements tab and try again.';
    case InventoryErrorCode.UNKNOWN:
    default:
      return parsed.detail || 'An unexpected error occurred. Please try again or contact support.';
  }
}

/** Convenience: parse + format in one call. */
export function describeRpcError(err: unknown): { code: InventoryErrorCode; userMessage: string; detail: string } {
  const parsed = parseRpcError(err);
  return {
    code: parsed.code,
    userMessage: formatUserMessage(parsed),
    detail: parsed.detail,
  };
}
