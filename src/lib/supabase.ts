/**
 * Supabase Client Configuration
 * Centralized client setup for pgasketsinv-final
 */

import { createClient } from '@supabase/supabase-js';
import type { Database } from '@/types/supabase';

// Environment variables validation
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase environment variables. Please check your .env.local file.'
  );
}

// Create Supabase client with TypeScript support
export const supabase = createClient<Database>(supabaseUrl, supabaseAnonKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  },
  realtime: {
    params: {
      eventsPerSecond: 10
    }
  }
});

// Helper function to handle Supabase errors
export function handleSupabaseError(error: any): never {
  console.error('Supabase error:', error);
  throw new Error(error.message || 'Database operation failed');
}

// Connection test function
export async function testConnection(): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('skus')
      .select('count')
      .limit(1);
    
    if (error) {
      console.error('Connection test failed:', error);
      return false;
    }
    
    console.log('✅ Supabase connection successful');
    return true;
  } catch (error) {
    console.error('Connection test error:', error);
    return false;
  }
}
