/**
 * FIFO Help Tooltip Component
 * Provides informative tooltips about FIFO validation rules and movement deletion restrictions
 */

import React from 'react';
import { 
  Info, 
  AlertTriangle, 
  Package, 
  Shield,
  Clock,
  Ban,
  CheckCircle
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface FIFOHelpTooltipProps {
  type: 'basic' | 'fifo-layers' | 'work-order-impact' | 'admin-override' | 'safe-to-delete' | 'validation-in-progress';
  className?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
}

const tooltipContent = {
  'basic': {
    icon: Info,
    title: 'FIFO Validation',
    content: 'This system uses First-In-First-Out (FIFO) inventory management. Receiving movements cannot be deleted if their inventory layers have been consumed by Work Orders.',
    color: 'blue'
  },
  'fifo-layers': {
    icon: Package,
    title: 'FIFO Layers Consumed',
    content: 'This receiving movement has created inventory layers that have been consumed by Work Orders. Deleting it would create data inconsistency and break FIFO tracking.',
    color: 'orange'
  },
  'work-order-impact': {
    icon: AlertTriangle,
    title: 'Work Order Impact',
    content: 'Deleting this receiving would affect Work Orders that have already consumed materials from these inventory layers. This could create invalid cost calculations.',
    color: 'red'
  },
  'admin-override': {
    icon: Shield,
    title: 'Admin Override Available',
    content: 'System administrators can force delete movements by bypassing FIFO validation. Use with extreme caution as this may cause data inconsistency.',
    color: 'purple'
  },
  'safe-to-delete': {
    icon: CheckCircle,
    title: 'Safe to Delete',
    content: 'This receiving movement has not been consumed by any Work Orders. It is safe to delete without affecting data integrity.',
    color: 'green'
  },
  'validation-in-progress': {
    icon: Clock,
    title: 'Validation in Progress',
    content: 'The system is checking if this movement can be safely deleted by analyzing FIFO layer consumption and Work Order impacts.',
    color: 'gray'
  }
};

const colorClasses = {
  blue: {
    bg: 'bg-blue-900',
    border: 'border-blue-700',
    text: 'text-blue-100',
    arrow: 'border-t-blue-900'
  },
  orange: {
    bg: 'bg-orange-900',
    border: 'border-orange-700', 
    text: 'text-orange-100',
    arrow: 'border-t-orange-900'
  },
  red: {
    bg: 'bg-red-900',
    border: 'border-red-700',
    text: 'text-red-100', 
    arrow: 'border-t-red-900'
  },
  purple: {
    bg: 'bg-purple-900',
    border: 'border-purple-700',
    text: 'text-purple-100',
    arrow: 'border-t-purple-900'
  },
  green: {
    bg: 'bg-green-900',
    border: 'border-green-700',
    text: 'text-green-100',
    arrow: 'border-t-green-900'
  },
  gray: {
    bg: 'bg-gray-900',
    border: 'border-gray-700',
    text: 'text-gray-100',
    arrow: 'border-t-gray-900'
  }
};

const placementClasses = {
  top: {
    tooltip: 'bottom-full left-1/2 transform -translate-x-1/2 mb-2',
    arrow: 'top-full left-1/2 transform -translate-x-1/2 border-4 border-transparent'
  },
  bottom: {
    tooltip: 'top-full left-1/2 transform -translate-x-1/2 mt-2',
    arrow: 'bottom-full left-1/2 transform -translate-x-1/2 border-4 border-transparent border-b-gray-900'
  },
  left: {
    tooltip: 'right-full top-1/2 transform -translate-y-1/2 mr-2',
    arrow: 'left-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-r-gray-900'
  },
  right: {
    tooltip: 'left-full top-1/2 transform -translate-y-1/2 ml-2',
    arrow: 'right-full top-1/2 transform -translate-y-1/2 border-4 border-transparent border-l-gray-900'
  }
};

export function FIFOHelpTooltip({ 
  type, 
  className, 
  placement = 'top' 
}: FIFOHelpTooltipProps) {
  const config = tooltipContent[type];
  const colors = colorClasses[config.color];
  const positions = placementClasses[placement];
  
  const IconComponent = config.icon;

  return (
    <div className={cn("relative inline-block group", className)}>
      <div className="cursor-help">
        <IconComponent className="h-4 w-4 text-slate-400 hover:text-slate-600" />
      </div>
      
      {/* Tooltip */}
      <div className={cn(
        "absolute z-10 max-w-sm px-3 py-2 text-sm rounded-lg opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none",
        colors.bg,
        colors.border,
        colors.text,
        positions.tooltip
      )}>
        <div className="flex items-start gap-2">
          <IconComponent className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium mb-1">{config.title}</div>
            <div className="text-xs leading-relaxed">{config.content}</div>
          </div>
        </div>
        
        {/* Arrow */}
        <div className={cn(
          "absolute",
          positions.arrow,
          colors.arrow
        )}></div>
      </div>
    </div>
  );
}

/**
 * Contextual Help for Movement List
 */
export function MovementListHelp() {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600 p-3 bg-blue-50 border border-blue-200 rounded-lg">
      <Info className="h-4 w-4 text-blue-600" />
      <div className="flex-1">
        <div className="font-medium text-blue-900 mb-1">FIFO Validation</div>
        <div className="text-blue-700 text-xs">
          Receiving movements cannot be deleted if their inventory layers have been consumed by Work Orders. 
          Use the checkboxes to select multiple movements for bulk validation and deletion.
        </div>
      </div>
      <FIFOHelpTooltip type="basic" placement="left" />
    </div>
  );
}

/**
 * Bulk Operations Help
 */
export function BulkOperationsHelp() {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600 p-3 bg-amber-50 border border-amber-200 rounded-lg">
      <Package className="h-4 w-4 text-amber-600" />
      <div className="flex-1">
        <div className="font-medium text-amber-900 mb-1">Bulk Delete Operations</div>
        <div className="text-amber-700 text-xs">
          The system will validate each selected movement individually. Movements with consumed FIFO layers will be skipped automatically to maintain data integrity.
        </div>
      </div>
    </div>
  );
}

/**
 * Admin Mode Help
 */
export function AdminModeHelp() {
  return (
    <div className="flex items-center gap-2 text-sm text-slate-600 p-3 bg-purple-50 border border-purple-200 rounded-lg">
      <Shield className="h-4 w-4 text-purple-600" />
      <div className="flex-1">
        <div className="font-medium text-purple-900 mb-1">Administrator Override</div>
        <div className="text-purple-700 text-xs">
          Admin mode allows bypassing FIFO validation. Use with extreme caution as this may cause data inconsistency and affect Work Order cost calculations.
        </div>
      </div>
      <FIFOHelpTooltip type="admin-override" placement="left" />
    </div>
  );
}

/**
 * Quick Help Badges for Different States
 */
interface QuickHelpBadgeProps {
  type: 'safe' | 'blocked' | 'validating' | 'admin';
  className?: string;
}

export function QuickHelpBadge({ type, className }: QuickHelpBadgeProps) {
  const configs = {
    safe: {
      tooltip: 'safe-to-delete' as const,
      icon: CheckCircle,
      text: 'Safe',
      bgColor: 'bg-green-100',
      textColor: 'text-green-800',
      borderColor: 'border-green-200'
    },
    blocked: {
      tooltip: 'fifo-layers' as const,
      icon: Ban,
      text: 'Blocked',
      bgColor: 'bg-red-100',
      textColor: 'text-red-800', 
      borderColor: 'border-red-200'
    },
    validating: {
      tooltip: 'validation-in-progress' as const,
      icon: Clock,
      text: 'Checking',
      bgColor: 'bg-gray-100',
      textColor: 'text-gray-800',
      borderColor: 'border-gray-200'
    },
    admin: {
      tooltip: 'admin-override' as const,
      icon: Shield,
      text: 'Admin',
      bgColor: 'bg-purple-100',
      textColor: 'text-purple-800',
      borderColor: 'border-purple-200'
    }
  };

  const config = configs[type];
  const IconComponent = config.icon;

  return (
    <div className={cn(
      "inline-flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md border",
      config.bgColor,
      config.textColor,
      config.borderColor,
      className
    )}>
      <IconComponent className="h-3 w-3" />
      <span>{config.text}</span>
      <FIFOHelpTooltip type={config.tooltip} placement="top" className="ml-1" />
    </div>
  );
}