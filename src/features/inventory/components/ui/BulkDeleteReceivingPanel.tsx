/**
 * Bulk Delete Receiving Panel
 * Handles bulk deletion of receiving movements with validation
 */

import React, { useState, useCallback, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { 
  Trash2, 
  CheckSquare, 
  Square, 
  AlertTriangle, 
  Loader2, 
  Info,
  Shield,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBulkReceivingDeleteValidation } from '@/features/inventory/hooks/useReceivingDeleteValidation';
import { softDeleteMovement } from '@/features/inventory/services/supabase/movement.service';
import { toast } from 'sonner';

export interface MovementItem {
  id: number;
  type: string;
  sku_id?: string;
  quantity: number;
  total_value: number;
  datetime: string;
  reference?: string;
}

export interface BulkDeleteReceivingPanelProps {
  movements: MovementItem[];
  selectedMovements: number[];
  onSelectionChange: (selectedIds: number[]) => void;
  onDeleteComplete: (deletedIds: number[], errors: string[]) => void;
  
  // UI customization
  showValidationSummary?: boolean;
  showProgressBar?: boolean;
  allowPartialDelete?: boolean;
  adminMode?: boolean;
  className?: string;
}

export function BulkDeleteReceivingPanel({
  movements,
  selectedMovements,
  onSelectionChange,
  onDeleteComplete,
  showValidationSummary = true,
  showProgressBar = true,
  allowPartialDelete = true,
  adminMode = false,
  className
}: BulkDeleteReceivingPanelProps) {

  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState(0);
  const [showConfirmation, setShowConfirmation] = useState(false);

  // Filter only RECEIVE movements for validation
  const receiveMovements = useMemo(() => 
    movements.filter(m => m.type === 'RECEIVE'),
    [movements]
  );

  const selectedReceiveMovements = useMemo(() => 
    selectedMovements.filter(id => 
      receiveMovements.some(m => m.id === id)
    ),
    [selectedMovements, receiveMovements]
  );

  // Bulk validation hook
  const {
    validating,
    results,
    blockedMovements,
    allowedMovements,
    error: validationError,
    validate,
    canDeleteMovement
  } = useBulkReceivingDeleteValidation(selectedReceiveMovements);

  // Handle select all/none
  const handleSelectAll = useCallback(() => {
    const allIds = movements.map(m => m.id);
    const isAllSelected = selectedMovements.length === movements.length;
    onSelectionChange(isAllSelected ? [] : allIds);
  }, [movements, selectedMovements, onSelectionChange]);

  // Handle individual selection
  const handleSelectMovement = useCallback((movementId: number, checked: boolean) => {
    if (checked) {
      onSelectionChange([...selectedMovements, movementId]);
    } else {
      onSelectionChange(selectedMovements.filter(id => id !== movementId));
    }
  }, [selectedMovements, onSelectionChange]);

  // Start bulk delete process
  const handleBulkDelete = useCallback(() => {
    if (!selectedMovements.length) return;
    
    if (!showConfirmation) {
      setShowConfirmation(true);
      return;
    }

    executeBulkDelete();
  }, [selectedMovements, showConfirmation]);

  const executeBulkDelete = useCallback(async () => {
    setIsDeleting(true);
    setDeleteProgress(0);
    setShowConfirmation(false);

    const deletedIds: number[] = [];
    const errors: string[] = [];
    
    try {
      // Separate RECEIVE and non-RECEIVE movements
      const receiveIds = selectedMovements.filter(id => 
        movements.find(m => m.id === id)?.type === 'RECEIVE'
      );
      const nonReceiveIds = selectedMovements.filter(id => 
        movements.find(m => m.id === id)?.type !== 'RECEIVE'
      );

      // For RECEIVE movements, respect validation unless admin override
      const safeToDeleteReceive = adminMode 
        ? receiveIds 
        : receiveIds.filter(id => canDeleteMovement(id));
        
      const blockedReceive = receiveIds.filter(id => !canDeleteMovement(id));

      if (!adminMode && blockedReceive.length > 0) {
        if (allowPartialDelete) {
          toast.warning(`${blockedReceive.length} movements blocked`, {
            description: 'Some movements cannot be deleted due to FIFO consumption'
          });
        } else {
          toast.error('Cannot delete any movements', {
            description: `${blockedReceive.length} movements are blocked due to FIFO consumption`
          });
          setIsDeleting(false);
          return;
        }
      }

      // Combine safe movements
      const movementsToDelete = [...safeToDeleteReceive, ...nonReceiveIds];
      
      if (movementsToDelete.length === 0) {
        toast.error('No movements can be deleted');
        setIsDeleting(false);
        return;
      }

      // Delete movements with progress tracking
      for (let i = 0; i < movementsToDelete.length; i++) {
        const movementId = movementsToDelete[i];
        
        try {
          await softDeleteMovement(movementId, {
            reason: 'Bulk deletion via UI',
            deletedBy: 'user',
            bypassValidation: adminMode
          });
          
          deletedIds.push(movementId);
          
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          errors.push(`Movement ${movementId}: ${errorMessage}`);
        }
        
        // Update progress
        const progress = ((i + 1) / movementsToDelete.length) * 100;
        setDeleteProgress(progress);
        
        // Small delay to show progress
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Show results
      if (deletedIds.length > 0) {
        toast.success(`${deletedIds.length} movements deleted successfully`);
      }
      
      if (errors.length > 0) {
        toast.error(`${errors.length} movements failed to delete`, {
          description: 'Check console for details'
        });
        console.error('Bulk delete errors:', errors);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Bulk delete failed';
      toast.error('Bulk delete failed', {
        description: errorMessage
      });
      errors.push(errorMessage);
      
    } finally {
      setIsDeleting(false);
      setDeleteProgress(0);
      onDeleteComplete(deletedIds, errors);
    }
  }, [
    selectedMovements,
    movements, 
    canDeleteMovement, 
    adminMode, 
    allowPartialDelete,
    onDeleteComplete
  ]);

  const handleCancelConfirmation = useCallback(() => {
    setShowConfirmation(false);
  }, []);

  // Calculate validation summary
  const validationSummary = useMemo(() => {
    const totalReceive = selectedReceiveMovements.length;
    const totalNonReceive = selectedMovements.length - totalReceive;
    const blocked = blockedMovements.length;
    const allowed = allowedMovements.length;
    
    return {
      totalReceive,
      totalNonReceive,
      blocked,
      allowed,
      safeToDelete: allowed + totalNonReceive
    };
  }, [selectedReceiveMovements, selectedMovements, blockedMovements, allowedMovements]);

  // Get status color for movement
  const getMovementStatusColor = useCallback((movement: MovementItem) => {
    if (movement.type !== 'RECEIVE') return 'green';
    if (validating) return 'gray';
    return canDeleteMovement(movement.id) ? 'green' : 'red';
  }, [validating, canDeleteMovement]);

  if (selectedMovements.length === 0) {
    return null;
  }

  return (
    <div className={cn("space-y-4 p-4 bg-gray-50 border rounded-lg", className)}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="font-medium">Bulk Delete</h3>
          <Badge variant="outline">
            {selectedMovements.length} selected
          </Badge>
          {adminMode && (
            <Badge variant="secondary" className="gap-1">
              <Shield className="h-3 w-3" />
              Admin Mode
            </Badge>
          )}
        </div>
        
        <Button
          variant="outline"
          size="sm"
          onClick={handleSelectAll}
          className="gap-2"
        >
          {selectedMovements.length === movements.length ? (
            <>
              <Square className="h-4 w-4" />
              Deselect All
            </>
          ) : (
            <>
              <CheckSquare className="h-4 w-4" />
              Select All
            </>
          )}
        </Button>
      </div>

      {/* Validation summary */}
      {showValidationSummary && selectedReceiveMovements.length > 0 && (
        <div className="bg-white border rounded-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <Info className="h-4 w-4 text-blue-600" />
            <span className="font-medium text-blue-900">Validation Summary</span>
          </div>
          
          {validating ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-sm text-gray-600">
                Validating {selectedReceiveMovements.length} receiving movements...
              </span>
            </div>
          ) : (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <div>
                <div className="text-gray-600">Safe to Delete</div>
                <div className="font-medium text-green-600">
                  {validationSummary.safeToDelete}
                </div>
              </div>
              <div>
                <div className="text-gray-600">Blocked (FIFO)</div>
                <div className="font-medium text-red-600">
                  {validationSummary.blocked}
                </div>
              </div>
              <div>
                <div className="text-gray-600">RECEIVE</div>
                <div className="font-medium">
                  {validationSummary.totalReceive}
                </div>
              </div>
              <div>
                <div className="text-gray-600">Other Types</div>
                <div className="font-medium">
                  {validationSummary.totalNonReceive}
                </div>
              </div>
            </div>
          )}
          
          {validationError && (
            <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-sm text-red-700">
              Validation error: {validationError}
            </div>
          )}
        </div>
      )}

      {/* Movement list */}
      <div className="max-h-64 overflow-y-auto space-y-2">
        {movements
          .filter(m => selectedMovements.includes(m.id))
          .map((movement) => {
            const statusColor = getMovementStatusColor(movement);
            const canDelete = movement.type !== 'RECEIVE' || canDeleteMovement(movement.id);
            
            return (
              <div
                key={movement.id}
                className={cn(
                  "flex items-center gap-3 p-2 bg-white border rounded",
                  {
                    'border-red-200 bg-red-50': !canDelete && !adminMode,
                    'border-green-200 bg-green-50': canDelete || adminMode,
                    'border-gray-200': validating
                  }
                )}
              >
                <Checkbox
                  checked={selectedMovements.includes(movement.id)}
                  onCheckedChange={(checked) => 
                    handleSelectMovement(movement.id, checked as boolean)
                  }
                />
                
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium font-mono text-sm">
                      #{movement.id}
                    </span>
                    <Badge variant="outline">
                      {movement.type}
                    </Badge>
                    {movement.sku_id && (
                      <Badge variant="secondary" className="font-mono">
                        {movement.sku_id}
                      </Badge>
                    )}
                  </div>
                  <div className="text-xs text-gray-600">
                    Qty: {movement.quantity} | Value: ${movement.total_value}
                  </div>
                </div>
                
                <div className="flex items-center gap-2">
                  {validating && movement.type === 'RECEIVE' ? (
                    <Loader2 className="h-3 w-3 animate-spin text-gray-400" />
                  ) : !canDelete && !adminMode ? (
                    <AlertTriangle className="h-4 w-4 text-red-500" title="Cannot delete - FIFO consumed" />
                  ) : null}
                </div>
              </div>
            );
          })}
      </div>

      {/* Progress bar */}
      {isDeleting && showProgressBar && (
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span>Deleting movements...</span>
            <span>{Math.round(deleteProgress)}%</span>
          </div>
          <Progress value={deleteProgress} className="w-full" />
        </div>
      )}

      {/* Actions */}
      {showConfirmation ? (
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-5 w-5 text-amber-500" />
          <span className="text-sm text-gray-700 flex-1">
            Are you sure you want to delete {validationSummary.safeToDelete} movement(s)?
            {validationSummary.blocked > 0 && !adminMode && (
              <span className="text-red-600">
                {' '}({validationSummary.blocked} will be skipped)
              </span>
            )}
          </span>
          <Button
            variant="destructive"
            size="sm"
            onClick={executeBulkDelete}
            disabled={isDeleting}
          >
            Yes, Delete
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancelConfirmation}
            disabled={isDeleting}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {validationSummary.blocked > 0 && !adminMode && (
              <span className="text-amber-600">
                {validationSummary.blocked} movements will be skipped
              </span>
            )}
          </div>
          
          <Button
            variant="destructive"
            onClick={handleBulkDelete}
            disabled={
              isDeleting || 
              validating || 
              (!adminMode && validationSummary.safeToDelete === 0)
            }
            className="gap-2"
          >
            {isDeleting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Deleting...
              </>
            ) : (
              <>
                <Trash2 className="h-4 w-4" />
                Delete {adminMode ? selectedMovements.length : validationSummary.safeToDelete}
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}