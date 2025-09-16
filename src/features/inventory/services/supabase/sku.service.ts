/**
 * SKU Service - Supabase Implementation
 * Handles all SKU-related database operations
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import type { UISKUOption, MaterialType, ProductCategory } from '@/features/inventory/types/inventory.types';
import { toSKUId } from '@/features/inventory/types/inventory.types';

type SKURow = Database['public']['Tables']['skus']['Row'];
type SKUInsert = Database['public']['Tables']['skus']['Insert'];
type SKUUpdate = Database['public']['Tables']['skus']['Update'];

/**
 * Convert database SKU row to UI SKU option
 */
function mapSKURowToUIOption(row: SKURow): UISKUOption {
  return {
    id: toSKUId(row.id),
    description: row.description,
    type: row.type as MaterialType,
    productCategory: row.product_category as ProductCategory,
    unit: row.unit,
    active: row.active,
    min: row.min_stock,
    onHand: row.on_hand,
  };
}

/**
 * Count SKUs by category (optionally only active)
 */
export async function countSKUsByCategory(categoryName: string, options?: { activeOnly?: boolean }): Promise<number> {
  try {
    let query = supabase
      .from('skus')
      .select('id', { count: 'exact', head: true })
      .eq('product_category', categoryName);

    if (options?.activeOnly) {
      query = query.eq('active', true);
    }

    const { count, error } = await query;
    if (error) handleSupabaseError(error);
    return count ?? 0;
  } catch (error) {
    console.error('Error counting SKUs by category:', error);
    throw error;
  }
}

/**
 * Get all SKUs with optional filtering
 */
export async function getSKUs(filters?: {
  type?: MaterialType;
  active?: boolean;
  searchTerm?: string;
}): Promise<UISKUOption[]> {
  try {
    let query = supabase
      .from('skus')
      .select('*')
      .order('id');

    // Apply filters
    if (filters?.type) {
      query = query.eq('type', filters.type);
    }
    
    if (filters?.active !== undefined) {
      query = query.eq('active', filters.active);
    }
    
    if (filters?.searchTerm) {
      query = query.or(`id.ilike.%${filters.searchTerm}%,description.ilike.%${filters.searchTerm}%`);
    }

    const { data, error } = await query;

    if (error) {
      handleSupabaseError(error);
    }

    return data?.map(mapSKURowToUIOption) || [];
  } catch (error) {
    console.error('Error fetching SKUs:', error);
    throw error;
  }
}

/**
 * Get SKU by ID
 */
export async function getSKUById(id: string): Promise<UISKUOption | null> {
  try {
    const { data, error } = await supabase
      .from('skus')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      handleSupabaseError(error);
    }

    return data ? mapSKURowToUIOption(data) : null;
  } catch (error) {
    console.error('Error fetching SKU by ID:', error);
    throw error;
  }
}

/**
 * Create new SKU
 */
export async function createSKU(sku: Omit<UISKUOption, 'onHand'>): Promise<UISKUOption> {
  try {
    const insertData: SKUInsert = {
      id: sku.id,
      description: sku.description || '',
      type: sku.type,
      product_category: sku.productCategory,
      unit: sku.unit || 'unit',
      active: sku.active ?? true,
      min_stock: sku.min || 0,
      on_hand: 0, // New SKUs start with 0 inventory
    };

    const { data, error } = await supabase
      .from('skus')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return mapSKURowToUIOption(data);
  } catch (error) {
    console.error('Error creating SKU:', error);
    throw error;
  }
}

/**
 * Update existing SKU
 */
export async function updateSKU(id: string, updates: Partial<UISKUOption>): Promise<UISKUOption> {
  try {
    const updateData: SKUUpdate = {};
    
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.type !== undefined) updateData.type = updates.type;
    if (updates.productCategory !== undefined) updateData.product_category = updates.productCategory;
    if (updates.unit !== undefined) updateData.unit = updates.unit;
    if (updates.active !== undefined) updateData.active = updates.active;
    if (updates.min !== undefined) updateData.min_stock = updates.min;
    if (updates.onHand !== undefined) updateData.on_hand = updates.onHand;

    updateData.updated_at = new Date().toISOString();

    const { data, error } = await supabase
      .from('skus')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return mapSKURowToUIOption(data);
  } catch (error) {
    console.error('Error updating SKU:', error);
    throw error;
  }
}

/**
 * Delete SKU (soft delete by setting active = false)
 */
export async function deleteSKU(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('skus')
      .update({ 
        active: false, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', id);

    if (error) {
      handleSupabaseError(error);
    }
  } catch (error) {
    console.error('Error deleting SKU:', error);
    throw error;
  }
}

/**
 * Get inventory summary with stock status
 */
export async function getInventorySummary(): Promise<Array<UISKUOption & { 
  status: 'OK' | 'BELOW_MIN' | 'OVERSTOCK';
  currentAvgCost: number;
  activeLayers: number;
}>> {
  try {
    const { data, error } = await supabase
      .from('inventory_summary')
      .select('*')
      .order('id');

    if (error) {
      handleSupabaseError(error);
    }

    return data?.map(row => ({
      id: toSKUId(row.id),
      description: row.description,
      type: row.type as MaterialType,
      productCategory: row.product_category as ProductCategory,
      unit: row.unit,
      active: row.active,
      min: row.min_stock,
      onHand: row.on_hand,
      status: row.status as 'OK' | 'BELOW_MIN' | 'OVERSTOCK',
      currentAvgCost: row.current_avg_cost,
      activeLayers: row.active_layers,
    })) || [];
  } catch (error) {
    console.error('Error fetching inventory summary:', error);
    throw error;
  }
}
