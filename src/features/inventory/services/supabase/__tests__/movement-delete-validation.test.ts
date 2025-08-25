/**
 * Tests for Movement Delete Validation Service
 * Ensures RECEIVE movements with consumed FIFO layers cannot be deleted
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import {
  canDeleteReceivingMovement,
  validateBulkReceivingDelete,
  canDeleteMovementQuick,
  getReceivingConsumptionDetails
} from '../movement-delete-validation.service';
import { supabase } from '@/lib/supabase';

// Mock Supabase
vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            single: vi.fn(),
            order: vi.fn(() => ({ single: vi.fn() }))
          })),
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              single: vi.fn()
            }))
          }))
        }))
      }))
    }))
  },
  handleSupabaseError: vi.fn()
}));

describe('Movement Delete Validation Service', () => {
  const mockSupabase = supabase.from as Mock;
  
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('canDeleteReceivingMovement', () => {
    it('should allow deletion when movement is not found', async () => {
      // Mock movement not found
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: null,
                error: { code: 'PGRST116' }
              })
            }))
          }))
        }))
      });

      const result = await canDeleteReceivingMovement(999);
      
      expect(result.canDelete).toBe(false);
      expect(result.reason).toContain('Movement not found');
    });

    it('should reject non-RECEIVE movements', async () => {
      // Mock ISSUE movement
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  id: 123,
                  type: 'ISSUE',
                  sku_id: 'SKU-001',
                  quantity: -500
                },
                error: null
              })
            }))
          }))
        }))
      });

      const result = await canDeleteReceivingMovement(123);
      
      expect(result.canDelete).toBe(false);
      expect(result.reason).toContain('Invalid movement type: ISSUE');
    });

    it('should allow deletion when no FIFO layers exist', async () => {
      // Mock RECEIVE movement
      const mockSelect = vi.fn();
      mockSupabase.mockReturnValue({
        select: mockSelect
      });

      // First call - get movement
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 123,
                type: 'RECEIVE',
                sku_id: 'SKU-001',
                quantity: 1000
              },
              error: null
            })
          }))
        }))
      });

      // Second call - get layers (none found)
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({
              data: [],
              error: null
            })
          }))
        }))
      });

      const result = await canDeleteReceivingMovement(123);
      
      expect(result.canDelete).toBe(true);
      expect(result.reason).toContain('No FIFO layers found');
    });

    it('should allow deletion when layers exist but are unconsumed', async () => {
      const mockSelect = vi.fn();
      mockSupabase.mockReturnValue({
        select: mockSelect
      });

      // First call - get movement
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 123,
                type: 'RECEIVE',
                sku_id: 'SKU-001',
                quantity: 1000
              },
              error: null
            })
          }))
        }))
      });

      // Second call - get unconsumed layers
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'SKU-001-L123',
                  sku_id: 'SKU-001',
                  original_quantity: 1000,
                  remaining_quantity: 1000, // Unconsumed
                  unit_cost: 5.0,
                  status: 'ACTIVE'
                }
              ],
              error: null
            })
          }))
        }))
      });

      const result = await canDeleteReceivingMovement(123);
      
      expect(result.canDelete).toBe(true);
      expect(result.totalRemaining).toBe(1000);
    });

    it('should block deletion when layers have been consumed', async () => {
      const mockSelect = vi.fn();
      mockSupabase.mockReturnValue({
        select: mockSelect
      });

      // First call - get movement
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            single: vi.fn().mockResolvedValue({
              data: {
                id: 123,
                type: 'RECEIVE',
                sku_id: 'SKU-001',
                quantity: 1000
              },
              error: null
            })
          }))
        }))
      });

      // Second call - get consumed layers
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'SKU-001-L123',
                  sku_id: 'SKU-001',
                  original_quantity: 1000,
                  remaining_quantity: 300, // 700 consumed
                  unit_cost: 5.0,
                  status: 'ACTIVE'
                }
              ],
              error: null
            })
          }))
        }))
      });

      // Third call - get layer consumptions
      mockSelect.mockReturnValueOnce({
        eq: vi.fn(() => ({
          is: vi.fn().mockResolvedValue({
            data: [
              {
                quantity_consumed: 700,
                total_cost: 3500,
                movement_id: 456,
                movements: {
                  work_order_id: 'WO-789',
                  type: 'ISSUE',
                  reference: 'WO-789'
                }
              }
            ],
            error: null
          })
        }))
      });

      const result = await canDeleteReceivingMovement(123);
      
      expect(result.canDelete).toBe(false);
      expect(result.reason).toContain('1 FIFO layer(s) have been consumed');
      expect(result.totalConsumed).toBe(700);
      expect(result.totalRemaining).toBe(300);
      expect(result.workOrdersAffected).toContain('WO-789');
      expect(result.affectedLayers).toHaveLength(1);
      expect(result.affectedLayers![0].consumedValue).toBe(3500);
    });
  });

  describe('validateBulkReceivingDelete', () => {
    it('should validate multiple movements correctly', async () => {
      const mockSelect = vi.fn();
      mockSupabase.mockReturnValue({
        select: mockSelect
      });

      // Mock responses for two movements
      // Movement 123 - can delete (unconsumed)
      // Movement 456 - cannot delete (consumed)
      
      let callCount = 0;
      mockSelect.mockImplementation(() => ({
        eq: vi.fn(() => ({
          is: vi.fn(() => ({
            single: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 1) {
                // First movement - RECEIVE
                return Promise.resolve({
                  data: { id: 123, type: 'RECEIVE', sku_id: 'SKU-001' },
                  error: null
                });
              } else if (callCount === 3) {
                // Second movement - RECEIVE  
                return Promise.resolve({
                  data: { id: 456, type: 'RECEIVE', sku_id: 'SKU-002' },
                  error: null
                });
              }
              return Promise.resolve({ data: null, error: null });
            })
          })),
          eq: vi.fn(() => ({
            eq: vi.fn().mockImplementation(() => {
              callCount++;
              if (callCount === 2) {
                // Layers for movement 123 - unconsumed
                return Promise.resolve({
                  data: [{
                    id: 'SKU-001-L123',
                    original_quantity: 1000,
                    remaining_quantity: 1000
                  }],
                  error: null
                });
              } else if (callCount === 4) {
                // Layers for movement 456 - consumed
                return Promise.resolve({
                  data: [{
                    id: 'SKU-002-L456',
                    original_quantity: 500,
                    remaining_quantity: 100
                  }],
                  error: null
                });
              }
              return Promise.resolve({ data: [], error: null });
            })
          }))
        }))
      }));

      const result = await validateBulkReceivingDelete([123, 456]);
      
      expect(result.allowed).toContain(123);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].movementId).toBe(456);
      expect(result.summary.totalMovements).toBe(2);
      expect(result.summary.allowedCount).toBe(1);
      expect(result.summary.blockedCount).toBe(1);
    });
  });

  describe('canDeleteMovementQuick', () => {
    it('should quickly return false for consumed layers', async () => {
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  type: 'RECEIVE',
                  fifo_layers: [
                    {
                      id: 'layer-1',
                      original_quantity: 1000,
                      remaining_quantity: 500 // Consumed
                    }
                  ]
                },
                error: null
              })
            }))
          }))
        }))
      });

      const result = await canDeleteMovementQuick(123);
      expect(result).toBe(false);
    });

    it('should quickly return true for unconsumed layers', async () => {
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: {
                  type: 'RECEIVE',
                  fifo_layers: [
                    {
                      id: 'layer-1',
                      original_quantity: 1000,
                      remaining_quantity: 1000 // Unconsumed
                    }
                  ]
                },
                error: null
              })
            }))
          }))
        }))
      });

      const result = await canDeleteMovementQuick(123);
      expect(result).toBe(true);
    });

    it('should return false on error for safety', async () => {
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockRejectedValue(new Error('Database error'))
            }))
          }))
        }))
      });

      const result = await canDeleteMovementQuick(123);
      expect(result).toBe(false); // Fail safe
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockRejectedValue(new Error('Connection error'))
            }))
          }))
        }))
      });

      const result = await canDeleteReceivingMovement(123);
      
      expect(result.canDelete).toBe(false);
      expect(result.reason).toContain('Error occurred during validation');
    });

    it('should handle malformed data gracefully', async () => {
      mockSupabase.mockReturnValue({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            is: vi.fn(() => ({
              single: vi.fn().mockResolvedValue({
                data: null, // Unexpected null
                error: null
              })
            }))
          }))
        }))
      });

      const result = await canDeleteReceivingMovement(123);
      
      expect(result.canDelete).toBe(false);
    });
  });
});