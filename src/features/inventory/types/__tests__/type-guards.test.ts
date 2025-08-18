import { describe, it, expect } from 'vitest';
import { isSKUId, isVendorId, isLayerId, isMovementId } from '../inventory.types';

/**
 * Testes unitários para type guards de Branded Types.
 * Regras resumidas:
 * - SKUId: regex /^[A-Z0-9-]+$/
 * - VendorId: começa com 'VND-' OU string não vazia
 * - LayerId: string não vazia
 * - MovementId: string não vazia
 */

describe('isSKUId', () => {
  it('deve aceitar strings válidas (maiúsculas, dígitos, hífen)', () => {
    expect(isSKUId('SKU-123')).toBe(true);
    expect(isSKUId('ABC')).toBe(true);
    expect(isSKUId('A1-B2-C3')).toBe(true);
  });

  it('deve rejeitar strings inválidas', () => {
    expect(isSKUId('')).toBe(false);
    expect(isSKUId('sku-123')).toBe(false); // minúsculas
    expect(isSKUId('SKU 123')).toBe(false); // espaço
    expect(isSKUId('SKU_123')).toBe(false); // underscore
    expect(isSKUId('SKU#123')).toBe(false); // caractere inválido
    expect(isSKUId(123 as any)).toBe(false);
    expect(isSKUId(null as any)).toBe(false);
    expect(isSKUId(undefined as any)).toBe(false);
  });
});

describe('isVendorId', () => {
  it("deve aceitar prefixo 'VND-'", () => {
    expect(isVendorId('VND-001')).toBe(true);
    expect(isVendorId('VND-ACME')).toBe(true);
  });

  it('deve aceitar string não vazia mesmo sem prefixo', () => {
    expect(isVendorId('ACME')).toBe(true);
    expect(isVendorId('123')).toBe(true);
  });

  it('deve rejeitar valores inválidos', () => {
    expect(isVendorId('')).toBe(false);
    expect(isVendorId(null as any)).toBe(false);
    expect(isVendorId(undefined as any)).toBe(false);
    expect(isVendorId(0 as any)).toBe(false);
  });
});

describe('isLayerId', () => {
  it('deve aceitar string não vazia', () => {
    expect(isLayerId('L1')).toBe(true);
    expect(isLayerId('any-layer-id')).toBe(true);
  });

  it('deve rejeitar vazia ou não-string', () => {
    expect(isLayerId('')).toBe(false);
    expect(isLayerId(null as any)).toBe(false);
    expect(isLayerId(undefined as any)).toBe(false);
    expect(isLayerId(42 as any)).toBe(false);
  });
});

describe('isMovementId', () => {
  it('deve aceitar string não vazia', () => {
    expect(isMovementId('M1')).toBe(true);
    expect(isMovementId('move-123')).toBe(true);
  });

  it('deve rejeitar vazia ou não-string', () => {
    expect(isMovementId('')).toBe(false);
    expect(isMovementId(null as any)).toBe(false);
    expect(isMovementId(undefined as any)).toBe(false);
    expect(isMovementId({} as any)).toBe(false);
  });
});
