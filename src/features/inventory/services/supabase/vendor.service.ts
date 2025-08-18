/**
 * Vendor Service - Supabase Implementation
 * Handles all vendor-related database operations
 */

import { supabase, handleSupabaseError } from '@/lib/supabase';
import type { Database } from '@/types/supabase';
import type { VendorSuggestion } from '@/features/inventory/types/inventory.types';
import { toVendorId } from '@/features/inventory/types/inventory.types';

type VendorRow = Database['public']['Tables']['vendors']['Row'];
type VendorInsert = Database['public']['Tables']['vendors']['Insert'];
type VendorUpdate = Database['public']['Tables']['vendors']['Update'];

/**
 * Convert database vendor row to UI suggestion format
 */
function mapVendorRowToSuggestion(row: VendorRow): VendorSuggestion {
  return {
    name: row.name,
    address: row.address || undefined,
    bank: row.bank_info ? JSON.stringify(row.bank_info) : undefined,
    email: row.email || undefined,
    phone: row.phone || undefined,
  };
}

/**
 * Get vendor suggestions for autocomplete (minimum 3 characters)
 */
export async function getVendorSuggestions(query: string): Promise<VendorSuggestion[]> {
  try {
    if (query.trim().length < 3) {
      return [];
    }

    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('active', true)
      .ilike('name', `%${query.trim()}%`)
      .order('name')
      .limit(8);

    if (error) {
      handleSupabaseError(error);
    }

    return data?.map(mapVendorRowToSuggestion) || [];
  } catch (error) {
    console.error('Error fetching vendor suggestions:', error);
    throw error;
  }
}

/**
 * Get all vendors with optional filtering
 */
export async function getVendors(filters?: {
  active?: boolean;
  searchTerm?: string;
}): Promise<VendorRow[]> {
  try {
    let query = supabase
      .from('vendors')
      .select('*')
      .order('name');

    if (filters?.active !== undefined) {
      query = query.eq('active', filters.active);
    }

    if (filters?.searchTerm) {
      query = query.ilike('name', `%${filters.searchTerm}%`);
    }

    const { data, error } = await query;

    if (error) {
      handleSupabaseError(error);
    }

    return data || [];
  } catch (error) {
    console.error('Error fetching vendors:', error);
    throw error;
  }
}

/**
 * Get vendor by ID
 */
export async function getVendorById(id: string): Promise<VendorRow | null> {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      handleSupabaseError(error);
    }

    return data;
  } catch (error) {
    console.error('Error fetching vendor by ID:', error);
    throw error;
  }
}

/**
 * Get vendor by name (for receiving form)
 */
export async function getVendorByName(name: string): Promise<VendorRow | null> {
  try {
    const { data, error } = await supabase
      .from('vendors')
      .select('*')
      .eq('name', name.trim())
      .eq('active', true)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null; // Not found
      }
      handleSupabaseError(error);
    }

    return data;
  } catch (error) {
    console.error('Error fetching vendor by name:', error);
    throw error;
  }
}

/**
 * Create new vendor
 */
export async function createVendor(vendor: {
  name: string;
  legalName?: string;
  address?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  email?: string;
  phone?: string;
  bankInfo?: Record<string, any>;
}): Promise<VendorRow> {
  try {
    // Generate vendor ID from name
    const vendorId = `VND-${vendor.name.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(0, 10)}`;

    const insertData: VendorInsert = {
      id: vendorId,
      name: vendor.name.trim(),
      legal_name: vendor.legalName?.trim(),
      address: vendor.address?.trim(),
      city: vendor.city?.trim(),
      state: vendor.state?.trim(),
      zip_code: vendor.zipCode?.trim(),
      email: vendor.email?.trim(),
      phone: vendor.phone?.trim(),
      bank_info: vendor.bankInfo || {},
    };

    const { data, error } = await supabase
      .from('vendors')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return data;
  } catch (error) {
    console.error('Error creating vendor:', error);
    throw error;
  }
}

/**
 * Update existing vendor
 */
export async function updateVendor(id: string, updates: Partial<VendorUpdate>): Promise<VendorRow> {
  try {
    const updateData: VendorUpdate = {
      ...updates,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('vendors')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      handleSupabaseError(error);
    }

    return data;
  } catch (error) {
    console.error('Error updating vendor:', error);
    throw error;
  }
}

/**
 * Delete vendor (soft delete by setting active = false)
 */
export async function deleteVendor(id: string): Promise<void> {
  try {
    const { error } = await supabase
      .from('vendors')
      .update({ 
        active: false, 
        updated_at: new Date().toISOString() 
      })
      .eq('id', id);

    if (error) {
      handleSupabaseError(error);
    }
  } catch (error) {
    console.error('Error deleting vendor:', error);
    throw error;
  }
}

/**
 * Create or get vendor by name (for receiving operations)
 */
export async function createOrGetVendorByName(name: string): Promise<VendorRow> {
  try {
    // First try to find existing vendor
    const existing = await getVendorByName(name);
    if (existing) {
      return existing;
    }

    // Create new vendor if not found
    return await createVendor({ name });
  } catch (error) {
    console.error('Error creating or getting vendor:', error);
    throw error;
  }
}
