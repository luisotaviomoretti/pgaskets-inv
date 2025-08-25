/**
 * Work Order Event Bus
 * Facilitates real-time communication between WorkOrder and Movements components
 */

// Event types for type safety
export interface WorkOrderCompletedEvent {
  workOrderId: string;
  outputName: string;
  outputQuantity: number;
  totalRawCost: number;
  movementIds?: number[];
}

export interface MovementCreatedEvent {
  movementId: number;
  type: 'RECEIVE' | 'ISSUE' | 'WASTE' | 'PRODUCE';
  skuId?: string;
  productName?: string;
  workOrderId?: string;
}

// Custom event types
declare global {
  interface WindowEventMap {
    'workOrderCompleted': CustomEvent<WorkOrderCompletedEvent>;
    'movementCreated': CustomEvent<MovementCreatedEvent>;
    'movementsRefreshRequested': CustomEvent<{ source: string }>;
  }
}

// Event bus singleton
class WorkOrderEventBus extends EventTarget {
  // Emit work order completion
  emitWorkOrderCompleted(data: WorkOrderCompletedEvent) {
    console.log('🚀 Work Order completed event emitted:', data);
    this.dispatchEvent(new CustomEvent('workOrderCompleted', { detail: data }));
  }

  // Emit movement creation
  emitMovementCreated(data: MovementCreatedEvent) {
    console.log('📝 Movement created event emitted:', data);
    this.dispatchEvent(new CustomEvent('movementCreated', { detail: data }));
  }

  // Request movements refresh
  emitMovementsRefreshRequested(source: string) {
    console.log('🔄 Movements refresh requested by:', source);
    this.dispatchEvent(new CustomEvent('movementsRefreshRequested', { detail: { source } }));
  }

  // Subscribe to work order completion
  onWorkOrderCompleted(callback: (event: CustomEvent<WorkOrderCompletedEvent>) => void) {
    const handler = callback as EventListener;
    this.addEventListener('workOrderCompleted', handler);
    return () => this.removeEventListener('workOrderCompleted', handler);
  }

  // Subscribe to movement creation
  onMovementCreated(callback: (event: CustomEvent<MovementCreatedEvent>) => void) {
    const handler = callback as EventListener;
    this.addEventListener('movementCreated', handler);
    return () => this.removeEventListener('movementCreated', handler);
  }

  // Subscribe to movements refresh requests
  onMovementsRefreshRequested(callback: (event: CustomEvent<{ source: string }>) => void) {
    const handler = callback as EventListener;
    this.addEventListener('movementsRefreshRequested', handler);
    return () => this.removeEventListener('movementsRefreshRequested', handler);
  }
}

// Export singleton instance
export const workOrderEvents = new WorkOrderEventBus();

// React hooks for easier component integration
export function useWorkOrderEvents() {
  return {
    emitWorkOrderCompleted: workOrderEvents.emitWorkOrderCompleted.bind(workOrderEvents),
    emitMovementCreated: workOrderEvents.emitMovementCreated.bind(workOrderEvents),
    emitMovementsRefreshRequested: workOrderEvents.emitMovementsRefreshRequested.bind(workOrderEvents),
    onWorkOrderCompleted: workOrderEvents.onWorkOrderCompleted.bind(workOrderEvents),
    onMovementCreated: workOrderEvents.onMovementCreated.bind(workOrderEvents),
    onMovementsRefreshRequested: workOrderEvents.onMovementsRefreshRequested.bind(workOrderEvents)
  };
}