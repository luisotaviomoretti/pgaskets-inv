/**
 * Receiving Delete Blocked Modal
 * Shows detailed information when a RECEIVE movement cannot be deleted
 */

import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Package } from '@/components/ui/icons';
import { 
  AlertTriangle, 
  DollarSign, 
  Calendar, 
  ExternalLink,
  Shield,
  Info,
  X
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DeleteValidationResult } from '@/features/inventory/services/supabase/movement-delete-validation.service';

export interface ReceivingDeleteBlockedModalProps {
  open: boolean;
  onClose: () => void;
  movementId: number;
  validationResult: DeleteValidationResult | null;
  
  // Optional callbacks
  onViewWorkOrder?: (workOrderId: string) => void;
  onContactAdmin?: () => void;
  onForceDelete?: () => void; // Admin override
  
  // UI customization
  showAdminOptions?: boolean;
  showWorkOrderLinks?: boolean;
  className?: string;
}

export function ReceivingDeleteBlockedModal({
  open,
  onClose,
  movementId,
  validationResult,
  onViewWorkOrder,
  onContactAdmin,
  onForceDelete,
  showAdminOptions = false,
  showWorkOrderLinks = true,
  className
}: ReceivingDeleteBlockedModalProps) {

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD'
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  const totalConsumedValue = validationResult?.affectedLayers?.reduce(
    (sum, layer) => sum + layer.consumedValue, 0
  ) || 0;
  
  // Early return if no validation result
  if (!validationResult) {
    return null;
  }

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className={cn("max-w-2xl max-h-[80vh] overflow-y-auto", className)}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-red-100 rounded-full">
              <AlertTriangle className="h-6 w-6 text-red-600" />
            </div>
            <div>
              <DialogTitle className="text-xl">Cannot Delete Receiving Movement</DialogTitle>
              <DialogDescription className="text-base mt-1">
                Movement ID: {movementId}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="space-y-6">
          {/* Main reason */}
          <div className="bg-red-50 border border-red-200 rounded-lg p-4">
            <div className="flex items-start gap-3">
              <Info className="h-5 w-5 text-red-600 mt-0.5 flex-shrink-0" />
              <div>
                <p className="font-medium text-red-800">Why can't this be deleted?</p>
                <p className="text-red-700 mt-1">{validationResult.reason}</p>
                <p className="text-red-600 text-sm mt-2">
                  Deleting this receiving would create data inconsistency and break FIFO inventory tracking.
                </p>
              </div>
            </div>
          </div>

          {/* Summary statistics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">
                {validationResult.affectedLayers?.length || 0}
              </div>
              <div className="text-sm text-gray-600">Affected Layers</div>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">
                {validationResult.totalConsumed?.toLocaleString() || 0}
              </div>
              <div className="text-sm text-gray-600">Units Consumed</div>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">
                {formatCurrency(totalConsumedValue)}
              </div>
              <div className="text-sm text-gray-600">Value Consumed</div>
            </div>
            
            <div className="bg-gray-50 rounded-lg p-3">
              <div className="text-2xl font-bold text-gray-900">
                {validationResult.workOrdersAffected?.length || 0}
              </div>
              <div className="text-sm text-gray-600">Work Orders</div>
            </div>
          </div>

          {/* Work Orders affected */}
          {validationResult.workOrdersAffected && validationResult.workOrdersAffected.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-gray-900 flex items-center gap-2">
                <Package className="h-4 w-4" />
                Affected Work Orders
              </h4>
              <div className="space-y-2">
                {validationResult.workOrdersAffected.map((workOrderId) => (
                  <div 
                    key={workOrderId}
                    className="flex items-center justify-between p-3 bg-orange-50 border border-orange-200 rounded-lg"
                  >
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="font-mono">
                        {workOrderId}
                      </Badge>
                      <span className="text-sm text-gray-600">
                        Used inventory from this receiving
                      </span>
                    </div>
                    {showWorkOrderLinks && onViewWorkOrder && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onViewWorkOrder(workOrderId)}
                        className="gap-2"
                      >
                        <ExternalLink className="h-3 w-3" />
                        View
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Layer details */}
          {validationResult.affectedLayers && validationResult.affectedLayers.length > 0 && (
            <div className="space-y-3">
              <h4 className="font-medium text-gray-900 flex items-center gap-2">
                <DollarSign className="h-4 w-4" />
                FIFO Layer Consumption Details
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {validationResult.affectedLayers.map((layer, index) => (
                  <div 
                    key={layer.layerId}
                    className="p-3 bg-gray-50 border rounded-lg"
                  >
                    <div className="flex items-center justify-between mb-2">
                      <div className="font-mono text-sm text-gray-800">
                        {layer.layerId}
                      </div>
                      <Badge variant="secondary">
                        {layer.skuId}
                      </Badge>
                    </div>
                    
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                      <div>
                        <div className="text-gray-600">Original</div>
                        <div className="font-medium">{layer.originalQuantity.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Consumed</div>
                        <div className="font-medium text-red-600">{layer.consumedQuantity.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Remaining</div>
                        <div className="font-medium text-green-600">{layer.remainingQuantity.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-gray-600">Value</div>
                        <div className="font-medium">{formatCurrency(layer.consumedValue)}</div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* What can be done */}
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
            <h4 className="font-medium text-blue-900 mb-2">What can you do?</h4>
            <ul className="text-blue-800 space-y-1 text-sm">
              <li>• Contact your system administrator if this deletion is critical</li>
              <li>• Review the affected Work Orders to understand the impact</li>
              <li>• Consider if there are alternative approaches to achieve your goal</li>
              {showAdminOptions && (
                <li className="text-orange-700">• Admin users can force delete (use with extreme caution)</li>
              )}
            </ul>
          </div>
        </div>

        <DialogFooter className="flex justify-between">
          <div className="flex gap-2">
            {onContactAdmin && (
              <Button variant="outline" onClick={onContactAdmin}>
                Contact Admin
              </Button>
            )}
          </div>
          
          <div className="flex gap-2">
            {showAdminOptions && onForceDelete && (
              <Button 
                variant="destructive" 
                onClick={onForceDelete}
                className="gap-2"
              >
                <Shield className="h-4 w-4" />
                Force Delete
              </Button>
            )}
            <Button variant="outline" onClick={onClose}>
              <X className="h-4 w-4 mr-2" />
              Close
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Simplified version that just shows the error
 */
export function SimpleReceivingDeleteBlockedModal({
  open,
  onClose,
  reason,
  workOrders = []
}: {
  open: boolean;
  onClose: () => void;
  reason: string;
  workOrders?: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <AlertTriangle className="h-6 w-6 text-red-600" />
            <DialogTitle>Cannot Delete</DialogTitle>
          </div>
        </DialogHeader>
        
        <div className="space-y-4">
          <p className="text-gray-700">{reason}</p>
          
          {workOrders.length > 0 && (
            <div>
              <p className="font-medium text-gray-900 mb-2">Affected Work Orders:</p>
              <div className="flex flex-wrap gap-2">
                {workOrders.map(wo => (
                  <Badge key={wo} variant="outline" className="font-mono">
                    {wo}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose}>
            Understood
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}