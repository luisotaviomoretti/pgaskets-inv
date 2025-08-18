import { useMutation, UseMutationOptions } from '@tanstack/react-query';
import { httpClient, HttpError } from './httpClient';

// Minimal payload type matching Receiving.tsx schema usage
export interface ReceiveLine {
  sku: string; // SKU code/id (string in UI layer)
  unit: string;
  qty: number;
  unitCost: number;
}

export interface ReceivePayload {
  vendorId: string; // branded at domain, string here in UI
  invoice: string; // packing slip / invoice
  datetime: string; // ISO string
  lines: ReceiveLine[];
  notes?: string;
  isDamaged?: boolean;
  damageScope?: 'NONE' | 'PARTIAL' | 'FULL';
  rejectedQty?: number;
}

export interface ReceiveResponse {
  id: string;
  status: 'OK';
}

export function useReceive(
  options?: UseMutationOptions<ReceiveResponse, HttpError | Error, ReceivePayload>
) {
  return useMutation<ReceiveResponse, HttpError | Error, ReceivePayload>({
    mutationKey: ['inventory', 'receive'],
    mutationFn: async (payload: ReceivePayload) => {
      return httpClient.post<ReceiveResponse>('/inventory/receivings', payload);
    },
    retry: 2,
    ...options,
  });
}
