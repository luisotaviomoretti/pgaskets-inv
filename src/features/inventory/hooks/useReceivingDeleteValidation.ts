/**
 * React Hook for Receiving Movement Delete Validation
 * Provides real-time validation state for movement deletion
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  canDeleteReceivingMovement,
  canDeleteMovementQuick,
  getReceivingConsumptionDetails,
  type DeleteValidationResult,
  type LayerConsumptionInfo
} from '../services/supabase/movement-delete-validation.service';

export interface UseReceivingDeleteValidationState {
  // Validation status
  canDelete: boolean;
  isLoading: boolean;
  isValidating: boolean;
  error: string | null;
  
  // Validation details
  validationResult: DeleteValidationResult | null;
  consumptionDetails: any | null;
  
  // Actions
  revalidate: () => Promise<void>;
  getDetails: () => Promise<void>;
  clear: () => void;
}

export interface UseReceivingDeleteValidationOptions {
  enabled?: boolean; // Auto-validate on mount/change
  quickCheck?: boolean; // Use quick validation initially
  autoRefresh?: number; // Auto-refresh interval in ms
  onValidationChange?: (canDelete: boolean, result: DeleteValidationResult | null) => void;
  onError?: (error: string) => void;
}

/**
 * Hook for validating single movement deletion
 */
export function useReceivingDeleteValidation(
  movementId: number | null,
  options: UseReceivingDeleteValidationOptions = {}
): UseReceivingDeleteValidationState {
  const {
    enabled = true,
    quickCheck = true,
    autoRefresh,
    onValidationChange,
    onError
  } = options;

  const [state, setState] = useState({
    canDelete: true,
    isLoading: false,
    isValidating: false,
    error: null as string | null,
    validationResult: null as DeleteValidationResult | null,
    consumptionDetails: null as any
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);

  const clear = useCallback(() => {
    setState({
      canDelete: true,
      isLoading: false,
      isValidating: false,
      error: null,
      validationResult: null,
      consumptionDetails: null
    });

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const validate = useCallback(async (useQuick = false) => {
    if (!movementId || !enabled) return;

    // Abort any existing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    setState(prev => ({
      ...prev,
      isValidating: true,
      error: null
    }));

    try {
      let result: DeleteValidationResult | null = null;
      let canDelete = false;

      if (useQuick) {
        // Quick validation first
        canDelete = await canDeleteMovementQuick(movementId);
        if (!canDelete) {
          // Get full details if blocked
          result = await canDeleteReceivingMovement(movementId);
          canDelete = result.canDelete;
        }
      } else {
        // Full validation
        result = await canDeleteReceivingMovement(movementId);
        canDelete = result.canDelete;
      }

      if (abortControllerRef.current?.signal.aborted) return;

      setState(prev => ({
        ...prev,
        canDelete,
        validationResult: result,
        isValidating: false,
        error: null
      }));

      onValidationChange?.(canDelete, result);

    } catch (error) {
      if (abortControllerRef.current?.signal.aborted) return;

      const errorMessage = error instanceof Error ? error.message : 'Validation failed';
      
      setState(prev => ({
        ...prev,
        canDelete: false, // Fail-safe: block deletion on error
        isValidating: false,
        error: errorMessage
      }));

      onError?.(errorMessage);
    }
  }, [movementId, enabled, onValidationChange, onError]);

  const revalidate = useCallback(async () => {
    await validate(false); // Always use full validation on manual revalidate
  }, [validate]);

  const getDetails = useCallback(async () => {
    if (!movementId) return;

    setState(prev => ({ ...prev, isLoading: true }));

    try {
      const details = await getReceivingConsumptionDetails(movementId);
      setState(prev => ({
        ...prev,
        consumptionDetails: details,
        isLoading: false
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to get details';
      setState(prev => ({
        ...prev,
        error: errorMessage,
        isLoading: false
      }));
    }
  }, [movementId]);

  // Initial validation
  useEffect(() => {
    if (movementId && enabled) {
      validate(quickCheck);
    } else {
      clear();
    }

    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [movementId, enabled, quickCheck]);

  // Auto-refresh setup
  useEffect(() => {
    if (!autoRefresh || !movementId || !enabled) return;

    timeoutRef.current = setInterval(() => {
      validate(true); // Use quick check for auto-refresh
    }, autoRefresh);

    return () => {
      if (timeoutRef.current) {
        clearInterval(timeoutRef.current);
      }
    };
  }, [autoRefresh, movementId, enabled]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clear();
    };
  }, []);

  return {
    ...state,
    revalidate,
    getDetails,
    clear
  };
}

/**
 * Hook for bulk validation (multiple movements)
 */
export function useBulkReceivingDeleteValidation(
  movementIds: number[],
  options: Omit<UseReceivingDeleteValidationOptions, 'quickCheck'> = {}
) {
  const { enabled = true, onValidationChange, onError } = options;
  
  const [state, setState] = useState({
    validating: false,
    results: new Map<number, boolean>(),
    blockedMovements: [] as number[],
    allowedMovements: [] as number[],
    error: null as string | null
  });

  const validate = useCallback(async () => {
    if (!movementIds.length || !enabled) return;

    setState(prev => ({ ...prev, validating: true, error: null }));

    try {
      const results = new Map<number, boolean>();
      const blocked: number[] = [];
      const allowed: number[] = [];

      // Validate in parallel with batching to avoid overwhelming the server
      const BATCH_SIZE = 5;
      const batches = [];
      
      for (let i = 0; i < movementIds.length; i += BATCH_SIZE) {
        batches.push(movementIds.slice(i, i + BATCH_SIZE));
      }

      for (const batch of batches) {
        const batchPromises = batch.map(async (id) => {
          try {
            const canDelete = await canDeleteMovementQuick(id);
            results.set(id, canDelete);
            return { id, canDelete };
          } catch (error) {
            results.set(id, false); // Fail-safe
            return { id, canDelete: false };
          }
        });

        const batchResults = await Promise.all(batchPromises);
        
        batchResults.forEach(({ id, canDelete }) => {
          if (canDelete) {
            allowed.push(id);
          } else {
            blocked.push(id);
          }
        });
      }

      setState(prev => ({
        ...prev,
        validating: false,
        results,
        blockedMovements: blocked,
        allowedMovements: allowed,
        error: null
      }));

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Bulk validation failed';
      setState(prev => ({
        ...prev,
        validating: false,
        error: errorMessage
      }));
      onError?.(errorMessage);
    }
  }, [movementIds, enabled, onError]);

  const canDeleteMovement = useCallback((movementId: number): boolean => {
    return state.results.get(movementId) ?? false;
  }, [state.results]);

  const getBlockedCount = useCallback((): number => {
    return state.blockedMovements.length;
  }, [state.blockedMovements.length]);

  const getAllowedCount = useCallback((): number => {
    return state.allowedMovements.length;
  }, [state.allowedMovements.length]);

  useEffect(() => {
    validate();
  }, [movementIds, enabled]);

  return {
    ...state,
    validate,
    canDeleteMovement,
    getBlockedCount,
    getAllowedCount
  };
}

/**
 * Hook for caching validation results (performance optimization)
 */
export function useValidationCache() {
  const cacheRef = useRef(new Map<number, {
    result: boolean;
    timestamp: number;
    ttl: number;
  }>());

  const getCachedResult = useCallback((movementId: number, ttl = 30000): boolean | null => {
    const cached = cacheRef.current.get(movementId);
    if (!cached) return null;

    const now = Date.now();
    if (now - cached.timestamp > ttl) {
      cacheRef.current.delete(movementId);
      return null;
    }

    return cached.result;
  }, []);

  const setCachedResult = useCallback((movementId: number, result: boolean, ttl = 30000) => {
    cacheRef.current.set(movementId, {
      result,
      timestamp: Date.now(),
      ttl
    });
  }, []);

  const clearCache = useCallback(() => {
    cacheRef.current.clear();
  }, []);

  return {
    getCachedResult,
    setCachedResult,
    clearCache
  };
}