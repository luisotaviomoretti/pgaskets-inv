import { describe, it, expect } from 'vitest';
import { isSKUId, isVendorId, isLayerId, isMovementId } from '../inventory.types';

/**
 * Testes unitários para type guards de Branded Types.
 * Regras resumidas:
 * - SKUId: string não vazia com até 120 caracteres
 * - VendorId: começa com 'VND-' OU string não vazia
 * - LayerId: string não vazia
 * - MovementId: string não vazia
 */

describe('isSKUId', () => {
  it('deve aceitar strings válidas (até 120 chars)', () => {
    expect(isSKUId('SKU-123')).toBe(true);
    expect(isSKUId('ABC')).toBe(true);
    expect(isSKUId('A1-B2-C3')).toBe(true);
    expect(isSKUId('R25 F-5031 BL 1/4 X 54')).toBe(true); // espaços, barras
    expect(isSKUId('R45 XI-20 NA  2 LB XLPE 1/2" X 60"')).toBe(true); // aspas
    expect(isSKUId('sku-123')).toBe(true); // minúsculas OK
  });

  it('deve rejeitar strings inválidas', () => {
    expect(isSKUId('')).toBe(false);
    expect(isSKUId('A'.repeat(121))).toBe(false); // excede 120 chars
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
