/**
 * Utilitários de validação para Branded Types do Inventário.
 *
 * Este módulo centraliza funções de validação e parsing seguro ("safe parse")
 * para IDs com brand (SKUId, VendorId, LayerId, MovementId) e validação em lote.
 */

import {
  // Branded Types
  SKUId,
  VendorId,
  LayerId,
  MovementId,
  // Type guards
  isSKUId,
  isVendorId,
  isLayerId,
  isMovementId,
} from '../types/inventory.types';

/**
 * Valida um valor arbitrário e retorna um SKUId.
 * Lança um erro se o valor não atender ao formato esperado (regex /^[A-Z0-9-]+$/).
 */
export const validateSKUId = (value: unknown): SKUId => {
  if (!isSKUId(value)) {
    throw new Error('SKUId inválido: esperado string que satisfaça /^[A-Z0-9-]+$/.');
  }
  return value as SKUId;
};

/**
 * Faz o parse seguro de um SKUId.
 * Retorna o SKUId quando válido; caso contrário, retorna null.
 */
export const safeParseSKUId = (value: unknown): SKUId | null => (isSKUId(value) ? (value as SKUId) : null);

/**
 * Valida um valor arbitrário e retorna um VendorId.
 * Regras: deve iniciar com 'VND-' OU ser uma string não vazia.
 */
export const validateVendorId = (value: unknown): VendorId => {
  if (!isVendorId(value)) {
    throw new Error("VendorId inválido: use prefixo 'VND-' ou uma string não vazia.");
  }
  return value as VendorId;
};

/**
 * Faz o parse seguro de um VendorId.
 * Retorna o VendorId quando válido; caso contrário, retorna null.
 */
export const safeParseVendorId = (value: unknown): VendorId | null => (isVendorId(value) ? (value as VendorId) : null);

/**
 * Valida um valor arbitrário e retorna um LayerId.
 * Regra: string não vazia.
 */
export const validateLayerId = (value: unknown): LayerId => {
  if (!isLayerId(value)) {
    throw new Error('LayerId inválido: string vazia não é permitida.');
  }
  return value as LayerId;
};

/**
 * Faz o parse seguro de um LayerId.
 * Retorna o LayerId quando válido; caso contrário, retorna null.
 */
export const safeParseLayerId = (value: unknown): LayerId | null => (isLayerId(value) ? (value as LayerId) : null);

/**
 * Valida um valor arbitrário e retorna um MovementId.
 * Regra: string não vazia.
 */
export const validateMovementId = (value: unknown): MovementId => {
  if (!isMovementId(value)) {
    throw new Error('MovementId inválido: string vazia não é permitida.');
  }
  return value as MovementId;
};

/**
 * Faz o parse seguro de um MovementId.
 * Retorna o MovementId quando válido; caso contrário, retorna null.
 */
export const safeParseMovementId = (value: unknown): MovementId | null => (isMovementId(value) ? (value as MovementId) : null);

/**
 * Valida um array utilizando uma função de parsing/validação de elemento.
 *
 * Exemplo:
 *   const validIds = validateBatch(inputs, validateSKUId)
 *
 * @param arr Array de valores a validar.
 * @param parser Função que valida e retorna o tipo alvo (ou lança erro).
 * @returns Um novo array contendo os valores convertidos/validados.
 * @throws Erro com o índice do elemento inválido para facilitar debug.
 */
export const validateBatch = <T>(arr: unknown[], parser: (v: unknown) => T): T[] => {
  if (!Array.isArray(arr)) {
    throw new Error('validateBatch: esperado um array.');
  }
  return arr.map((v, idx) => {
    try {
      return parser(v);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new Error(`validateBatch: elemento inválido no índice ${idx}: ${reason}`);
    }
  });
};
