/**
 * Utilitários de formatação para o módulo de Inventário.
 * - IDs, enums e status de estoque para exibição na UI
 * - Moeda (BRL) usando Intl.NumberFormat
 */

import { SKUId, MaterialType, MovementType } from '../types/inventory.types';

/**
 * Mapa de rótulos amigáveis para MaterialType.
 * Ajuste conforme linguagem/terminologia do negócio.
 */
export const MATERIAL_TYPE_LABELS: Record<MaterialType, string> = {
  [MaterialType.RAW]: 'Matéria-prima',
  [MaterialType.SELLABLE]: 'Produto vendável',
};

/**
 * Rótulos amigáveis para MovementType.
 */
export const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  [MovementType.RECEIVE]: 'Recebimento',
  [MovementType.ISSUE]: 'Uso de Material',
  [MovementType.WASTE]: 'Sucata/Perda',
  [MovementType.PRODUCE]: 'COGS',
  [MovementType.ADJUSTMENT]: 'Ajuste',
  [MovementType.TRANSFER]: 'Transferência',
};

/**
 * Representa o status de estoque baseado em mínimos/máximos.
 */
export type StockStatusCode = 'OK' | 'BELOW_MIN' | 'ABOVE_MAX';
export interface StockStatus {
  code: StockStatusCode;
  label: string;
}

/**
 * Formata um SKUId para exibição.
 * Como SKUId é uma string branded, apenas devolvemos a string.
 */
export const formatSKUId = (id: SKUId): string => id as unknown as string;

/**
 * Formata o tipo de material em rótulo amigável.
 */
export const formatMaterialType = (type: MaterialType): string => MATERIAL_TYPE_LABELS[type] ?? String(type);

/**
 * Formata o tipo de movimento em rótulo amigável.
 */
export const formatMovementType = (type: MovementType): string => MOVEMENT_TYPE_LABELS[type] ?? String(type);

/**
 * Calcula e descreve o status de estoque com base em valores atuais e limites.
 * - BELOW_MIN: current < min
 * - ABOVE_MAX: max definido e current > max
 * - OK: caso contrário
 */
export const formatStockStatus = (current: number, min: number, max?: number): StockStatus => {
  if (current < min) return { code: 'BELOW_MIN', label: 'Abaixo do mínimo' };
  if (typeof max === 'number' && current > max) return { code: 'ABOVE_MAX', label: 'Acima do máximo' };
  return { code: 'OK', label: 'OK' };
};

/**
 * Formata valores monetários em CAD (Dólar Canadense).
 * Usa Intl.NumberFormat com locale en-CA e moeda CAD.
 */
export const formatCurrency = (value: number): string =>
  new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(value);
