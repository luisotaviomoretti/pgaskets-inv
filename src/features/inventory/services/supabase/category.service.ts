/**
 * Category Service - Supabase Implementation
 * Handles all Category-related database operations
 * Non-disruptive: does not depend on generated Database types for safety
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';

export type UICategory = {
  id: string;
  name: string;
  active: boolean;
  description?: string;
  sortOrder?: number | null;
  slug?: string | null;
  createdAt?: string; // ISO
  updatedAt?: string; // ISO
};
export type RenameCategoryResult = {
  success: boolean;
  dryRun: boolean;
  categoriesUpdated?: number;
  skusUpdated?: number;
  error?: string;
  code?: string;
};

function toSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+)|(-+$)/g, '');
  return base || 'category';
}

/**
 * Rename a category and retag SKUs atomically via RPC
 * - Supports dry-run to preview impact
 */
export async function renameCategoryAndRetagSkus(
  oldName: string,
  newName: string,
  options?: { dryRun?: boolean }
): Promise<RenameCategoryResult> {
  try {
    const { data, error } = await supabase.rpc('rename_category_and_retag_skus', {
      old_name: oldName,
      new_name: newName,
      dry_run: Boolean(options?.dryRun)
    });

    if (error) handleSupabaseError(error);
    return (data || { success: false, dryRun: Boolean(options?.dryRun) }) as RenameCategoryResult;
  } catch (error) {
    console.error('Error renaming category via RPC:', error);
    throw error;
  }
}

function mapRowToUICategory(row: any): UICategory {
  return {
    id: String(row.id),
    name: String(row.name),
    active: Boolean(row.active),
    description: row.description ?? undefined,
    sortOrder: row.sort_order ?? null,
    slug: row.slug ?? null,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

/**
 * Get categories with optional filters
 */
export async function getCategories(filters?: {
  active?: boolean;
  searchTerm?: string;
}): Promise<UICategory[]> {
  try {
    let query = supabase.from('categories').select('*');

    if (typeof filters?.active === 'boolean') {
      query = query.eq('active', filters.active);
    }

    if (filters?.searchTerm) {
      // simple ILIKE on name
      query = query.ilike('name', `%${filters.searchTerm}%`);
    }

    // deterministic ordering
    query = query.order('sort_order', { ascending: true, nullsFirst: false }).order('name', { ascending: true });

    const { data, error } = await query;
    if (error) handleSupabaseError(error);

    return (data || []).map(mapRowToUICategory);
  } catch (error) {
    console.error('Error fetching categories:', error);
    throw error;
  }
}

/**
 * Get category by ID
 */
export async function getCategoryById(id: string): Promise<UICategory | null> {
  try {
    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      // PostgREST not found code: PGRST116
      if ((error as any)?.code === 'PGRST116') return null;
      handleSupabaseError(error);
    }

    return data ? mapRowToUICategory(data) : null;
  } catch (error) {
    console.error('Error fetching category by ID:', error);
    throw error;
  }
}

/**
 * Create new category
 * - Generates an ID from slug(name) by default
 */
export async function createCategory(input: {
  name: string;
  description?: string;
  sortOrder?: number;
}): Promise<UICategory> {
  try {
    const name = (input.name || '').trim();
    if (!name) throw new Error('Category name is required');

    const id = toSlug(name);

    const insertData = {
      id,
      name,
      slug: id,
      description: input.description ?? null,
      active: true,
      sort_order: typeof input.sortOrder === 'number' ? input.sortOrder : null,
      // created_at/updated_at default from DB
    } as any;

    const { data, error } = await supabase
      .from('categories')
      .insert(insertData)
      .select('*')
      .single();

    if (error) handleSupabaseError(error);

    return mapRowToUICategory(data);
  } catch (error) {
    console.error('Error creating category:', error);
    throw error;
  }
}

/**
 * Update existing category
 */
export async function updateCategory(id: string, updates: Partial<UICategory>): Promise<UICategory> {
  try {
    const updateData: any = { updated_at: new Date().toISOString() };

    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.description !== undefined) updateData.description = updates.description;
    if (updates.active !== undefined) updateData.active = updates.active;
    if (updates.sortOrder !== undefined) updateData.sort_order = updates.sortOrder;
    if (updates.slug !== undefined) updateData.slug = updates.slug;

    const { data, error } = await supabase
      .from('categories')
      .update(updateData)
      .eq('id', id)
      .select('*')
      .single();

    if (error) handleSupabaseError(error);

    return mapRowToUICategory(data);
  } catch (error) {
    console.error('Error updating category:', error);
    throw error;
  }
}

/**
 * Soft delete a category (active = false)
 */
export async function deleteCategory(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('categories')
      .update({ active: false, updated_at: new Date().toISOString() } as any)
      .eq('id', id);

    if (error) handleSupabaseError(error);
  } catch (error) {
    console.error('Error deleting category:', error);
    throw error;
  }
}
