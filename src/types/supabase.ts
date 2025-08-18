/**
 * Supabase Database Types
 * Auto-generated types for pgasketsinv-final database schema
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export interface Database {
  public: {
    Tables: {
      skus: {
        Row: {
          id: string
          description: string
          type: 'RAW' | 'SELLABLE'
          product_category: string
          unit: string
          active: boolean
          min_stock: number
          max_stock: number | null
          on_hand: number
          reserved: number
          average_cost: number | null
          last_cost: number | null
          created_at: string
          updated_at: string
          created_by: string
          updated_by: string
          metadata: Json
        }
        Insert: {
          id: string
          description: string
          type: 'RAW' | 'SELLABLE'
          product_category: string
          unit: string
          active?: boolean
          min_stock?: number
          max_stock?: number | null
          on_hand?: number
          reserved?: number
          average_cost?: number | null
          last_cost?: number | null
          created_at?: string
          updated_at?: string
          created_by?: string
          updated_by?: string
          metadata?: Json
        }
        Update: {
          id?: string
          description?: string
          type?: 'RAW' | 'SELLABLE'
          product_category?: string
          unit?: string
          active?: boolean
          min_stock?: number
          max_stock?: number | null
          on_hand?: number
          reserved?: number
          average_cost?: number | null
          last_cost?: number | null
          created_at?: string
          updated_at?: string
          created_by?: string
          updated_by?: string
          metadata?: Json
        }
      }
      vendors: {
        Row: {
          id: string
          name: string
          legal_name: string | null
          tax_id: string | null
          address: string | null
          city: string | null
          state: string | null
          zip_code: string | null
          country: string
          email: string | null
          phone: string | null
          bank_info: Json
          payment_terms: Json
          rating: number | null
          active: boolean
          created_at: string
          updated_at: string
          metadata: Json
        }
        Insert: {
          id: string
          name: string
          legal_name?: string | null
          tax_id?: string | null
          address?: string | null
          city?: string | null
          state?: string | null
          zip_code?: string | null
          country?: string
          email?: string | null
          phone?: string | null
          bank_info?: Json
          payment_terms?: Json
          rating?: number | null
          active?: boolean
          created_at?: string
          updated_at?: string
          metadata?: Json
        }
        Update: {
          id?: string
          name?: string
          legal_name?: string | null
          tax_id?: string | null
          address?: string | null
          city?: string | null
          state?: string | null
          zip_code?: string | null
          country?: string
          email?: string | null
          phone?: string | null
          bank_info?: Json
          payment_terms?: Json
          rating?: number | null
          active?: boolean
          created_at?: string
          updated_at?: string
          metadata?: Json
        }
      }
      fifo_layers: {
        Row: {
          id: string
          sku_id: string
          receiving_date: string
          expiry_date: string | null
          original_quantity: number
          remaining_quantity: number
          unit_cost: number
          vendor_id: string | null
          packing_slip_no: string | null
          lot_number: string | null
          location: string | null
          status: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'QUARANTINE'
          created_at: string
          last_movement_at: string | null
        }
        Insert: {
          id: string
          sku_id: string
          receiving_date: string
          expiry_date?: string | null
          original_quantity: number
          remaining_quantity: number
          unit_cost: number
          vendor_id?: string | null
          packing_slip_no?: string | null
          lot_number?: string | null
          location?: string | null
          status?: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'QUARANTINE'
          created_at?: string
          last_movement_at?: string | null
        }
        Update: {
          id?: string
          sku_id?: string
          receiving_date?: string
          expiry_date?: string | null
          original_quantity?: number
          remaining_quantity?: number
          unit_cost?: number
          vendor_id?: string | null
          packing_slip_no?: string | null
          lot_number?: string | null
          location?: string | null
          status?: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'QUARANTINE'
          created_at?: string
          last_movement_at?: string | null
        }
      }
      movements: {
        Row: {
          id: number
          datetime: string
          type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE' | 'ADJUSTMENT' | 'TRANSFER'
          sku_id: string | null
          product_name: string | null
          quantity: number
          unit_cost: number | null
          total_value: number
          reference: string
          work_order_id: string | null
          notes: string | null
          user_id: string
          reversed_at: string | null
          reversed_by: string | null
          created_at: string
          vendor_id: string | null
        }
        Insert: {
          id?: number
          datetime: string
          type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE' | 'ADJUSTMENT' | 'TRANSFER'
          sku_id?: string | null
          product_name?: string | null
          quantity: number
          unit_cost?: number | null
          total_value: number
          reference: string
          work_order_id?: string | null
          notes?: string | null
          user_id?: string
          reversed_at?: string | null
          reversed_by?: string | null
          created_at?: string
          vendor_id?: string | null
        }
        Update: {
          id?: number
          datetime?: string
          type?: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE' | 'ADJUSTMENT' | 'TRANSFER'
          sku_id?: string | null
          product_name?: string | null
          quantity?: number
          unit_cost?: number | null
          total_value?: number
          reference?: string
          work_order_id?: string | null
          notes?: string | null
          user_id?: string
          reversed_at?: string | null
          reversed_by?: string | null
          created_at?: string
          vendor_id?: string | null
        }
      }
      work_orders: {
        Row: {
          id: string
          output_name: string
          output_quantity: number
          output_unit: string | null
          mode: 'AUTO' | 'MANUAL'
          client_name: string | null
          invoice_no: string | null
          status: string
          total_cost: number | null
          labor_hours: number | null
          notes: string | null
          created_at: string
          completed_at: string | null
          created_by: string
        }
        Insert: {
          id: string
          output_name: string
          output_quantity: number
          output_unit?: string | null
          mode: 'AUTO' | 'MANUAL'
          client_name?: string | null
          invoice_no?: string | null
          status?: string
          total_cost?: number | null
          labor_hours?: number | null
          notes?: string | null
          created_at?: string
          completed_at?: string | null
          created_by?: string
        }
        Update: {
          id?: string
          output_name?: string
          output_quantity?: number
          output_unit?: string | null
          mode?: 'AUTO' | 'MANUAL'
          client_name?: string | null
          invoice_no?: string | null
          status?: string
          total_cost?: number | null
          labor_hours?: number | null
          notes?: string | null
          created_at?: string
          completed_at?: string | null
          created_by?: string
        }
      }
      layer_consumptions: {
        Row: {
          id: number
          movement_id: number
          layer_id: string
          quantity_consumed: number
          unit_cost: number
          total_cost: number
          created_at: string
        }
        Insert: {
          id?: number
          movement_id: number
          layer_id: string
          quantity_consumed: number
          unit_cost: number
          total_cost: number
          created_at?: string
        }
        Update: {
          id?: number
          movement_id?: number
          layer_id?: string
          quantity_consumed?: number
          unit_cost?: number
          total_cost?: number
          created_at?: string
        }
      }
      receiving_batches: {
        Row: {
          id: string
          vendor_id: string
          packing_slip_no: string
          receiving_date: string
          is_damaged: boolean
          damage_scope: 'NONE' | 'PARTIAL' | 'FULL'
          damage_description: string | null
          notes: string | null
          total_value: number | null
          created_at: string
          created_by: string
        }
        Insert: {
          id: string
          vendor_id: string
          packing_slip_no: string
          receiving_date: string
          is_damaged?: boolean
          damage_scope?: 'NONE' | 'PARTIAL' | 'FULL'
          damage_description?: string | null
          notes?: string | null
          total_value?: number | null
          created_at?: string
          created_by?: string
        }
        Update: {
          id?: string
          vendor_id?: string
          packing_slip_no?: string
          receiving_date?: string
          is_damaged?: boolean
          damage_scope?: 'NONE' | 'PARTIAL' | 'FULL'
          damage_description?: string | null
          notes?: string | null
          total_value?: number | null
          created_at?: string
          created_by?: string
        }
      }
    }
    Views: {
      inventory_summary: {
        Row: {
          id: string
          description: string
          type: 'RAW' | 'SELLABLE'
          product_category: string
          unit: string
          on_hand: number
          reserved: number
          min_stock: number
          max_stock: number | null
          active: boolean
          status: 'BELOW_MIN' | 'OVERSTOCK' | 'OK'
          current_avg_cost: number
          active_layers: number
          total_in_layers: number
        }
      }
      movement_history: {
        Row: {
          id: number
          datetime: string
          type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE' | 'ADJUSTMENT' | 'TRANSFER'
          sku_or_name: string
          quantity: number
          total_value: number
          reference: string
          work_order_id: string | null
          notes: string | null
          unit: string | null
          sku_description: string | null
        }
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      damage_scope: 'NONE' | 'PARTIAL' | 'FULL'
      layer_status: 'ACTIVE' | 'EXHAUSTED' | 'EXPIRED' | 'QUARANTINE'
      material_type: 'RAW' | 'SELLABLE'
      movement_type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE' | 'ADJUSTMENT' | 'TRANSFER'
      work_order_mode: 'AUTO' | 'MANUAL'
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
