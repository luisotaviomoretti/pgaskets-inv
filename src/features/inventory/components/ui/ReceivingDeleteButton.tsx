/**
 * Receiving Delete Button Component
 * Smart button that validates FIFO consumption before allowing deletion
 */

import React, { useState, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { 
  Trash2, 
  Ban, 
  Loader2, 
  AlertTriangle, 
  Info, 
  Shield,
  CheckCircle 
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useReceivingDeleteValidation } from '@/features/inventory/hooks/useReceivingDeleteValidation';
import { softDeleteMovement } from '@/features/inventory/services/supabase/movement.service';
import { toast } from 'sonner';

export interface ReceivingDeleteButtonProps {
  movementId: number;
  movementType?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  variant?: 'default' | 'destructive' | 'outline' | 'ghost';
  
  // Event handlers
  onDeleteStart?: () => void;
  onDeleteSuccess?: (movementId: number) => void;
  onDeleteError?: (error: string) => void;
  onValidationBlocked?: (reason: string, workOrders?: string[]) => void;
  
  // Customization
  showTooltip?: boolean;
  showDetails?: boolean;
  confirmationRequired?: boolean;
  
  // Advanced options
  enableQuickValidation?: boolean;
  adminMode?: boolean; // Allows bypass validation
  
  // Text customization
  labels?: {
    delete?: string;
    deleting?: string;
    validating?: string;
    blocked?: string;
    cannotDelete?: string;
  };
}

export function ReceivingDeleteButton({
  movementId,
  movementType = 'UNKNOWN',
  className,
  size = 'sm',
  variant = 'destructive',
  onDeleteStart,
  onDeleteSuccess,
  onDeleteError,
  onValidationBlocked,
  showTooltip = true,
  showDetails = true,
  confirmationRequired = true,
  enableQuickValidation = true,
  adminMode = false,
  labels = {}
}: ReceivingDeleteButtonProps) {
  
  const [isDeleting, setIsDeleting] = useState(false);
  const [showConfirmation, setShowConfirmation] = useState(false);

  const {
    canDelete,
    isValidating,
    error: validationError,
    validationResult,
    revalidate
  } = useReceivingDeleteValidation(movementId, {
    enabled: movementType === 'RECEIVE', // Only validate RECEIVE movements
    quickCheck: enableQuickValidation,
    onValidationChange: (canDelete, result) => {
      if (!canDelete && result) {
        onValidationBlocked?.(
          result.reason || 'Cannot delete',
          result.workOrdersAffected
        );
      }
    },
    onError: (error) => {
      onDeleteError?.(error);
    }
  });

  const handleDeleteClick = useCallback(async () => {
    if (!canDelete && !adminMode) {
      // Show detailed error for blocked deletion
      const reason = validationResult?.reason || 'Cannot delete this movement';
      const workOrders = validationResult?.workOrdersAffected || [];
      
      toast.error('Cannot Delete Movement', {
        description: reason + (workOrders.length ? `\nAffected Work Orders: ${workOrders.join(', ')}` : ''),
        duration: 5000,
      });
      
      onValidationBlocked?.(reason, workOrders);
      return;
    }

    if (confirmationRequired && !showConfirmation) {
      setShowConfirmation(true);
      return;
    }

    await executeDelete();
  }, [canDelete, adminMode, validationResult, confirmationRequired, showConfirmation]);

  const executeDelete = useCallback(async () => {
    setIsDeleting(true);
    setShowConfirmation(false);
    onDeleteStart?.();

    try {
      await softDeleteMovement(movementId, {
        reason: 'User deletion via UI',
        deletedBy: 'user',
        bypassValidation: adminMode
      });

      toast.success('Movement deleted successfully');
      onDeleteSuccess?.(movementId);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to delete movement';
      
      toast.error('Delete Failed', {
        description: errorMessage,
        duration: 5000,
      });
      
      onDeleteError?.(errorMessage);
    } finally {
      setIsDeleting(false);
    }
  }, [movementId, adminMode, onDeleteStart, onDeleteSuccess, onDeleteError]);

  const handleCancelConfirmation = useCallback(() => {
    setShowConfirmation(false);
  }, []);

  // Skip validation for non-RECEIVE movements
  if (movementType !== 'RECEIVE') {
    return (
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={isDeleting}
        onClick={executeDelete}
      >
        {isDeleting ? (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {labels.deleting || 'Deleting...'}
          </>
        ) : (
          <>
            <Trash2 className="h-4 w-4 mr-2" />
            {labels.delete || 'Delete'}
          </>
        )}
      </Button>
    );
  }

  // Get current button state
  const getButtonState = () => {
    if (isDeleting) return 'deleting';
    if (isValidating) return 'validating';
    if (validationError) return 'error';
    if (!canDelete && !adminMode) return 'blocked';
    if (showConfirmation) return 'confirming';
    return 'ready';
  };

  const buttonState = getButtonState();

  // Button content based on state
  const getButtonContent = () => {
    switch (buttonState) {
      case 'deleting':
        return (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {labels.deleting || 'Deleting...'}
          </>
        );
        
      case 'validating':
        return (
          <>
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            {labels.validating || 'Checking...'}
          </>
        );
        
      case 'error':
        return (
          <>
            <AlertTriangle className="h-4 w-4 mr-2" />
            Error
          </>
        );
        
      case 'blocked':
        return (
          <>
            <Ban className="h-4 w-4 mr-2" />
            {labels.blocked || 'Cannot Delete'}
          </>
        );
        
      case 'confirming':
        return (
          <>
            <AlertTriangle className="h-4 w-4 mr-2" />
            Confirm Delete?
          </>
        );
        
      default:
        return (
          <>
            {adminMode ? (
              <Shield className="h-4 w-4 mr-2" />
            ) : (
              <Trash2 className="h-4 w-4 mr-2" />
            )}
            {labels.delete || 'Delete'}
          </>
        );
    }
  };

  // Button variant based on state
  const getButtonVariant = () => {
    switch (buttonState) {
      case 'error':
        return 'outline';
      case 'blocked':
        return 'outline';
      case 'confirming':
        return 'destructive';
      default:
        return variant;
    }
  };

  // Tooltip content
  const getTooltipContent = () => {
    if (!showTooltip) return null;
    
    switch (buttonState) {
      case 'validating':
        return 'Checking if movement can be safely deleted...';
        
      case 'error':
        return `Validation error: ${validationError}`;
        
      case 'blocked':
        return validationResult?.reason || 'Cannot delete - would cause data inconsistency';
        
      case 'confirming':
        return 'Click again to confirm deletion';
        
      case 'ready':
        return canDelete 
          ? 'Safe to delete - no FIFO layers consumed'
          : 'Cannot delete - FIFO layers have been consumed';
          
      default:
        return null;
    }
  };

  const tooltipContent = getTooltipContent();

  if (showConfirmation) {
    return (
      <div className="flex gap-2">
        <Button
          variant="destructive"
          size={size}
          onClick={executeDelete}
          disabled={isDeleting}
        >
          <CheckCircle className="h-4 w-4 mr-2" />
          Yes, Delete
        </Button>
        <Button
          variant="outline"
          size={size}
          onClick={handleCancelConfirmation}
          disabled={isDeleting}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="relative group">
      <Button
        variant={getButtonVariant()}
        size={size}
        className={cn(
          className,
          {
            'opacity-50 cursor-not-allowed': buttonState === 'blocked' && !adminMode,
            'border-amber-500 text-amber-700 hover:bg-amber-50': buttonState === 'blocked',
            'border-red-500 text-red-700 hover:bg-red-50': buttonState === 'error',
            'animate-pulse': buttonState === 'validating'
          }
        )}
        disabled={
          isDeleting || 
          isValidating || 
          (buttonState === 'blocked' && !adminMode) ||
          !!validationError
        }
        onClick={handleDeleteClick}
        title={tooltipContent || undefined}
      >
        {getButtonContent()}
      </Button>

      {/* Details badge */}
      {showDetails && validationResult && !validationResult.canDelete && (
        <div className="absolute -top-2 -right-2 bg-red-500 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">
          {validationResult.affectedLayers?.length || '!'}
        </div>
      )}

      {/* Tooltip */}
      {tooltipContent && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-gray-900 text-white text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
          {tooltipContent}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-t-gray-900"></div>
        </div>
      )}

      {/* Admin mode indicator */}
      {adminMode && (
        <div className="absolute -top-1 -left-1 bg-orange-500 text-white text-xs rounded-full w-4 h-4 flex items-center justify-center">
          <Shield className="h-2 w-2" />
        </div>
      )}
    </div>
  );
}

/**
 * Simplified version for basic use cases
 */
export function SimpleReceivingDeleteButton({
  movementId,
  movementType,
  onSuccess,
  onError,
  className
}: {
  movementId: number;
  movementType?: string;
  onSuccess?: () => void;
  onError?: (error: string) => void;
  className?: string;
}) {
  return (
    <ReceivingDeleteButton
      movementId={movementId}
      movementType={movementType}
      className={className}
      onDeleteSuccess={onSuccess}
      onDeleteError={onError}
      confirmationRequired={true}
      showTooltip={true}
      showDetails={true}
    />
  );
}

/**
 * Admin version with bypass capability
 */
export function AdminReceivingDeleteButton({
  movementId,
  movementType,
  onSuccess,
  onError,
  className
}: {
  movementId: number;
  movementType?: string;
  onSuccess?: () => void;
  onError?: (error: string) => void;
  className?: string;
}) {
  return (
    <ReceivingDeleteButton
      movementId={movementId}
      movementType={movementType}
      className={className}
      onDeleteSuccess={onSuccess}
      onDeleteError={onError}
      adminMode={true}
      variant="outline"
      labels={{
        delete: 'Admin Delete',
        blocked: 'Force Delete'
      }}
    />
  );
}