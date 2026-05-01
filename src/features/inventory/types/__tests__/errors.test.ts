import { describe, it, expect } from 'vitest';
import {
  parseRpcError,
  formatUserMessage,
  describeRpcError,
  InventoryErrorCode,
} from '../errors';

describe('parseRpcError', () => {
  it('parses a JSON envelope from migration 044/045/046', () => {
    const err = {
      message: '{"code":"INSUFFICIENT_STOCK","detail":"SKU X has 5 available; needed 10","sku_id":"X","available":5,"needed":10}',
      code: '23514',
    };
    const parsed = parseRpcError(err);
    expect(parsed.code).toBe(InventoryErrorCode.INSUFFICIENT_STOCK);
    expect(parsed.detail).toContain('SKU X');
    expect(parsed.context).toMatchObject({ sku_id: 'X', available: 5, needed: 10 });
  });

  it('parses INVALID_INPUT envelope', () => {
    const err = { message: '{"code":"INVALID_INPUT","detail":"Quantity must be positive: -1"}' };
    const parsed = parseRpcError(err);
    expect(parsed.code).toBe(InventoryErrorCode.INVALID_INPUT);
    expect(parsed.detail).toContain('positive');
  });

  it('parses NOT_FOUND envelope', () => {
    const err = { message: '{"code":"NOT_FOUND","detail":"WO ABC not found"}' };
    const parsed = parseRpcError(err);
    expect(parsed.code).toBe(InventoryErrorCode.NOT_FOUND);
  });

  it('falls back to substring classification for non-JSON messages', () => {
    expect(parseRpcError({ message: 'Insufficient stock for X' }).code).toBe(InventoryErrorCode.INSUFFICIENT_STOCK);
    expect(parseRpcError({ message: 'Failed to fetch' }).code).toBe(InventoryErrorCode.NETWORK);
    expect(parseRpcError({ message: 'consistent_total check failed' }).code).toBe(InventoryErrorCode.DECIMAL_PRECISION);
    expect(parseRpcError({ message: 'thing not found' }).code).toBe(InventoryErrorCode.NOT_FOUND);
  });

  it('returns UNKNOWN for unrecognized messages', () => {
    const parsed = parseRpcError({ message: 'something completely unexpected' });
    expect(parsed.code).toBe(InventoryErrorCode.UNKNOWN);
    expect(parsed.detail).toBe('something completely unexpected');
  });

  it('classifies pg unique_violation (23505) as DUPLICATE_REQUEST', () => {
    const err = { message: 'duplicate key value violates unique constraint "x"', code: '23505' };
    const parsed = parseRpcError(err);
    expect(parsed.code).toBe(InventoryErrorCode.DUPLICATE_REQUEST);
  });

  it('handles native Error objects', () => {
    const err = new Error('Failed to fetch');
    expect(parseRpcError(err).code).toBe(InventoryErrorCode.NETWORK);
  });

  it('handles string errors', () => {
    expect(parseRpcError('Insufficient stock').code).toBe(InventoryErrorCode.INSUFFICIENT_STOCK);
  });

  it('handles null/undefined gracefully', () => {
    expect(parseRpcError(null).code).toBe(InventoryErrorCode.UNKNOWN);
    expect(parseRpcError(undefined).code).toBe(InventoryErrorCode.UNKNOWN);
  });

  it('handles malformed JSON in message field', () => {
    const err = { message: '{not valid json' };
    const parsed = parseRpcError(err);
    expect(parsed.code).toBe(InventoryErrorCode.UNKNOWN);
    expect(parsed.detail).toContain('not valid json');
  });

  it('treats unknown JSON code as UNKNOWN but keeps detail', () => {
    const err = { message: '{"code":"WHO_KNOWS","detail":"hi"}' };
    const parsed = parseRpcError(err);
    expect(parsed.code).toBe(InventoryErrorCode.UNKNOWN);
    expect(parsed.detail).toBe('hi');
  });
});

describe('formatUserMessage', () => {
  it('produces a structured message for INSUFFICIENT_STOCK with context', () => {
    const msg = formatUserMessage({
      code: InventoryErrorCode.INSUFFICIENT_STOCK,
      detail: 'irrelevant',
      raw: '',
      context: { sku_id: 'X', available: 2, needed: 10 },
    });
    expect(msg).toContain('X');
    expect(msg).toContain('2');
    expect(msg).toContain('10');
  });

  it('falls back to detail when no context provided', () => {
    const msg = formatUserMessage({
      code: InventoryErrorCode.INSUFFICIENT_STOCK,
      detail: 'Custom detail',
      raw: '',
    });
    expect(msg).toContain('Custom detail');
  });

  it('returns a friendly message for every known code', () => {
    for (const code of Object.values(InventoryErrorCode)) {
      const msg = formatUserMessage({ code, detail: 'detail-text', raw: '' });
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});

describe('describeRpcError', () => {
  it('combines parse + format', () => {
    const out = describeRpcError({ message: '{"code":"NETWORK","detail":"timeout"}' });
    expect(out.code).toBe(InventoryErrorCode.NETWORK);
    expect(out.userMessage).toMatch(/network/i);
    expect(out.detail).toBe('timeout');
  });
});
