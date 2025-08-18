import { useState, useMemo, useRef, useDeferredValue, useEffect } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import ConfirmDialog from '@/components/common/ConfirmDialog';
import type { MovementLogEntry, MovementId } from '@/features/inventory/types/inventory.types';
import { MovementType } from '@/features/inventory/types/inventory.types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

// Types imported from shared domain

// Props interface
interface MovementsProps {
  movements?: MovementLogEntry[];
  onDeleteMovement?: (movementId: MovementId) => void;
  onExportExcel?: (filteredMovements: any[], activeFilters: any) => void;
}

// Movement type badge colors
function getMovementBadgeVariant(type: MovementType): "default" | "secondary" {
  switch (type) {
    case MovementType.RECEIVE: return 'default';
    case MovementType.PRODUCE: return 'default';
    case MovementType.ISSUE: return 'secondary';
    case MovementType.WASTE: return 'secondary';
    default: return 'secondary';
  }
}

// Trash icon for delete button
function Trash({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

// (removed misplaced top-level useEffect; logic moved inside component)

// Period types matching Dashboard pattern
type PeriodOption = 'today' | 'last7' | 'month' | 'quarter' | 'custom';

// Time range helper functions (from Dashboard pattern)
const ONE_DAY = 24 * 60 * 60 * 1000;
function getRange(period: PeriodOption, customStart?: string, customEnd?: string) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (period === 'today') return [startOfToday, now.getTime()] as const;
  if (period === 'last7') return [now.getTime() - 7 * ONE_DAY, now.getTime()] as const;
  if (period === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), now.getTime()] as const;
  if (period === 'custom') {
    const s = customStart ? new Date(customStart + 'T00:00:00').getTime() : now.getTime() - 7 * ONE_DAY;
    const e = customEnd ? new Date(customEnd + 'T23:59:59').getTime() : now.getTime();
    return [Math.min(s, e), Math.max(s, e)] as const;
  }
  const qStartMonth = Math.floor(now.getMonth() / 3) * 3;
  return [new Date(now.getFullYear(), qStartMonth, 1).getTime(), now.getTime()] as const;
}

export default function Movements({ movements = [], onDeleteMovement, onExportExcel }: MovementsProps) {
  const [skuFilter, setSkuFilter] = useState('');
  const [woFilter, setWoFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [period, setPeriod] = useState<PeriodOption>('last7');
  const [customStart, setCustomStart] = useState<string>('');
  const [customEnd, setCustomEnd] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<MovementId | null>(null);
  const [confirmationAnimal, setConfirmationAnimal] = useState<string | null>(null);
  // confirmation handled by ConfirmDialog

  // Export confirmation state
  const [showExportConfirm, setShowExportConfirm] = useState(false);

  // Pagination state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  // Debounced filters (lower-priority updates)
  const deferredSku = useDeferredValue(skuFilter);
  const deferredWo = useDeferredValue(woFilter);

  // i18n-ready formatters (use default locale; currency can be wired to env)
  const currencyFmt = useMemo(
    () => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }),
    []
  );
  const dateTimeFmt = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
    []
  );
  // (modal focus/Esc handled by ConfirmDialog)

  // Token list (10 animals in EN)
  const animals = useMemo(
    () => [
      'turtle',
      'lion',
      'giraffe',
      'parrot',
      'alligator',
      'jaguar',
      'elephant',
      'wolf',
      'dolphin',
      'eagle',
    ],
    []
  );

  // Normalize helper (case/accents-insensitive)
  // (normalize no longer needed here; handled inside ConfirmDialog)

  // Ask for confirmation: pick a random animal
  const askConfirm = (movementId: MovementId) => {
    const token = animals[Math.floor(Math.random() * animals.length)] || 'turtle';
    setConfirmationAnimal(token);
    setConfirmDelete(movementId);
  };

  // Helper to find movement by ID
  const findMovementById = (id: MovementId) => {
    return movements?.find(m => m.movementId === id);
  };

  // Get active filters for display and export
  const activeFilters = useMemo(() => {
    return {
      sku: deferredSku,
      workOrder: deferredWo,
      type: typeFilter,
      period: period,
      customStart: period === 'custom' ? customStart : '',
      customEnd: period === 'custom' ? customEnd : '',
    };
  }, [deferredSku, deferredWo, typeFilter, period, customStart, customEnd]);

  // Helper to format period for display
  const formatPeriodDisplay = () => {
    switch (period) {
      case 'today': return 'Today';
      case 'last7': return 'Last 7 days';
      case 'month': return 'Current month';
      case 'quarter': return 'Current quarter';
      case 'custom': return customStart && customEnd 
        ? `${customStart} to ${customEnd}` 
        : 'Custom range (incomplete)';
      default: return period;
    }
  };

  // Handle export confirmation
  const handleExportClick = () => {
    setShowExportConfirm(true);
  };

  const handleExportConfirm = () => {
    if (onExportExcel) {
      onExportExcel(filteredMovements, activeFilters);
    }
    setShowExportConfirm(false);
  };

  // Calculate date range based on period selection
  const [rangeStart, rangeEnd] = useMemo(() => {
    return getRange(period, customStart, customEnd);
  }, [period, customStart, customEnd]);

  // Filter and sort movements (newest first) and return tuples [movement, originalIndex] to avoid O(n) findIndex
  const filteredMovements = useMemo(() => {
    const result: Array<[MovementLogEntry, number]> = [];
    (movements || []).forEach((movement, originalIndex) => {
      // SKU/Name filter
      if (deferredSku && !movement.skuOrName.toLowerCase().includes(deferredSku.toLowerCase())) return;
      
      // WO filter
      if (deferredWo && !movement.ref.toLowerCase().includes(deferredWo.toLowerCase())) return;
      
      // Type filter
      if (typeFilter && movement.type !== typeFilter) return;
      
      // Period filter (replace simple date filter)
      const movementTime = movement.datetime instanceof Date 
        ? movement.datetime.getTime()
        : new Date(movement.datetime).getTime();
      if (movementTime < rangeStart || movementTime > rangeEnd) return;
      
      result.push([movement, originalIndex]);
    });
    
    // Sort by datetime (newest first)
    result.sort(([a], [b]) => {
      const timeA = a.datetime instanceof Date ? a.datetime.getTime() : new Date(a.datetime).getTime();
      const timeB = b.datetime instanceof Date ? b.datetime.getTime() : new Date(b.datetime).getTime();
      return timeB - timeA; // Descending order (newest first)
    });
    
    return result;
  }, [movements, deferredSku, deferredWo, typeFilter, rangeStart, rangeEnd]);

  // Reset to first page when filters change
  useEffect(() => {
    setPage(1);
  }, [deferredSku, deferredWo, typeFilter, period, customStart, customEnd]);

  // Pagination derivations
  const totalRows = filteredMovements.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const clampedPage = Math.min(page, totalPages);
  const start = (clampedPage - 1) * pageSize;
  const end = start + pageSize;
  const pagedMovements = filteredMovements.slice(start, end);

  // Virtualization over the current page
  const tableBodyParentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: pagedMovements.length,
    getScrollElement: () => tableBodyParentRef.current,
    estimateSize: () => 44, // px per row (adjust if row height changes)
    overscan: 8,
  });

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-dashed">
        <CardHeader className="py-4">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <CardTitle className="text-lg">Last Movements</CardTitle>
            <div className="flex flex-col md:flex-row items-start md:items-center gap-2">
              {/* Period filter following Dashboard pattern */}
              <Select value={period} onValueChange={(v) => setPeriod(v as PeriodOption)}>
                <SelectTrigger className="h-8 w-[160px] rounded-xl">
                  <SelectValue placeholder="Period" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="today">Today</SelectItem>
                  <SelectItem value="last7">Last 7 days</SelectItem>
                  <SelectItem value="month">Current month</SelectItem>
                  <SelectItem value="quarter">Current quarter</SelectItem>
                  <SelectItem value="custom">Custom range</SelectItem>
                </SelectContent>
              </Select>
              {period === 'custom' && (
                <div className="flex items-center gap-2">
                  <Input 
                    type="date" 
                    value={customStart} 
                    onChange={(e) => setCustomStart(e.target.value)} 
                    className="h-8 rounded-xl w-36" 
                  />
                  <span className="text-slate-500">to</span>
                  <Input 
                    type="date" 
                    value={customEnd} 
                    onChange={(e) => setCustomEnd(e.target.value)} 
                    className="h-8 rounded-xl w-36" 
                  />
                </div>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Export button with count */}
          <div className="flex items-center justify-between">
            <div className="text-sm text-slate-600">
              Showing {filteredMovements.length} of {movements.length} movements
            </div>
            <Button 
              size="sm" 
              variant="outline" 
              onClick={handleExportClick}
              disabled={filteredMovements.length === 0}
              className="rounded-xl"
            >
              Export to Excel ({filteredMovements.length})
            </Button>
          </div>
          
          {/* Additional filters below header */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Input 
              placeholder="Filter by SKU or Name"
              value={skuFilter}
              onChange={(e) => setSkuFilter(e.target.value)}
              className="h-8 rounded-xl"
            />
            <Input 
              placeholder="Filter by WO"
              value={woFilter}
              onChange={(e) => setWoFilter(e.target.value)}
              className="h-8 rounded-xl"
            />
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 w-full rounded-xl">
                <SelectValue placeholder="Movement type"/>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">All types</SelectItem>
                <SelectItem value={MovementType.RECEIVE}>RECEIVE</SelectItem>
                <SelectItem value={MovementType.ISSUE}>ISSUE</SelectItem>
                <SelectItem value={MovementType.WASTE}>WASTE</SelectItem>
                <SelectItem value={MovementType.PRODUCE}>PRODUCE</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Virtualized scroll container around the table */}
          <div ref={tableBodyParentRef} className="max-h-96 overflow-auto rounded-md border">
          <Table className="w-full">
            <caption className="sr-only">Last Movements – filtered and paginated list</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Date/Time</TableHead>
                <TableHead scope="col">Type</TableHead>
                <TableHead scope="col">SKU / Output name</TableHead>
                <TableHead scope="col">Qty</TableHead>
                <TableHead scope="col">Value</TableHead>
                <TableHead scope="col">Ref</TableHead>
                <TableHead scope="col">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredMovements.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-slate-500">
                    {skuFilter || woFilter || typeFilter || period !== 'last7' || customStart || customEnd
                      ? 'No movements match the current filters.' 
                      : 'No movements yet.'
                    }
                  </TableCell>
                </TableRow>
              ) : (
                (() => {
                  const virtualItems = rowVirtualizer.getVirtualItems();
                  const paddingTop = virtualItems[0]?.start ?? 0;
                  const last = virtualItems[virtualItems.length - 1];
                  const paddingBottom = rowVirtualizer.getTotalSize() - ((last?.end) ?? 0);

                  return (
                    <>
                      {paddingTop > 0 && (
                        <TableRow aria-hidden style={{ height: paddingTop }}>
                          <TableCell colSpan={7} />
                        </TableRow>
                      )}
                      {virtualItems.map((vi) => {
                        const [m, originalIndex] = pagedMovements[vi.index]!;
                        const stableKey = `${m.ref}|${m.datetime}|${m.type}|${m.skuOrName}`;
                        return (
                          <TableRow key={stableKey} data-index={vi.index}>
                            {/** First cell as row header for screen readers */}
                            <th scope="row" className="px-4 py-2 text-left font-normal">
                              {dateTimeFmt.format(m.datetime instanceof Date ? m.datetime : new Date(m.datetime))}
                            </th>
                            <TableCell>
                              <Badge variant={getMovementBadgeVariant(m.type)}>{m.type}</Badge>
                            </TableCell>
                            <TableCell>{m.skuOrName}</TableCell>
                            <TableCell className={m.qty > 0 ? 'text-green-600' : 'text-red-600'}>
                              {m.qty > 0 ? `+${m.qty}` : m.qty}
                            </TableCell>
                            <TableCell className={m.value > 0 ? 'text-green-600' : 'text-red-600'}>
                              {currencyFmt.format(m.value)}
                            </TableCell>
                            <TableCell>{m.ref}</TableCell>
                            <TableCell>
                              {(m.type === MovementType.PRODUCE || m.type === MovementType.RECEIVE) && onDeleteMovement && (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => askConfirm(m.movementId)}
                                  className="h-8 w-8 p-0 text-red-600 hover:text-red-700 hover:bg-red-50"
                                  aria-label="Delete movement"
                                  title="Delete movement"
                                >
                                  <Trash className="h-4 w-4" />
                                </Button>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {paddingBottom > 0 && (
                        <TableRow aria-hidden style={{ height: paddingBottom }}>
                          <TableCell colSpan={7} />
                        </TableRow>
                      )}
                    </>
                  );
                })()
              )}
            </TableBody>
          </Table>
          </div>
          {/* Pagination controls */}
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 pt-2">
            <div className="text-sm text-slate-600">
              Showing {totalRows === 0 ? 0 : start + 1}-{Math.min(end, totalRows)} of {totalRows}
            </div>
            <div className="flex items-center gap-2">
              <Select value={String(pageSize)} onValueChange={(v) => { setPageSize(Number(v)); setPage(1); }}>
                <SelectTrigger className="h-9 w-[110px]"><SelectValue placeholder="Page size" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="10">10 / page</SelectItem>
                  <SelectItem value="25">25 / page</SelectItem>
                  <SelectItem value="50">50 / page</SelectItem>
                  <SelectItem value="100">100 / page</SelectItem>
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1">
                <Button variant="outline" size="sm" onClick={() => setPage(1)} disabled={clampedPage === 1}>«</Button>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={clampedPage === 1}>Prev</Button>
                <span className="text-sm px-2">Page {clampedPage} / {totalPages}</span>
                <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={clampedPage === totalPages}>Next</Button>
                <Button variant="outline" size="sm" onClick={() => setPage(totalPages)} disabled={clampedPage === totalPages}>»</Button>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Export confirmation modal */}
      {showExportConfirm && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowExportConfirm(false)}></div>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(100%,500px)]">
            <Card className="rounded-2xl shadow-2xl bg-white">
              <CardHeader className="py-4">
                <CardTitle className="text-lg">Export Movements to Excel</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-slate-600">
                  You're about to export <strong>{filteredMovements.length} movement records</strong> to Excel with the following filters applied:
                </p>
                
                <div className="bg-slate-50 p-3 rounded-lg space-y-2">
                  <div className="text-sm font-medium text-slate-700">Active Filters:</div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <span className="font-medium">Period:</span> {formatPeriodDisplay()}
                    </div>
                    <div>
                      <span className="font-medium">SKU/Name:</span> {activeFilters.sku || 'All'}
                    </div>
                    <div>
                      <span className="font-medium">Work Order:</span> {activeFilters.workOrder || 'All'}
                    </div>
                    <div>
                      <span className="font-medium">Movement Type:</span> {activeFilters.type || 'All'}
                    </div>
                  </div>
                </div>

                <p className="text-xs text-slate-500">
                  The exported file will contain: Date, Time, Type, SKU/Product, Quantity, Value, and Reference columns.
                </p>
              </CardContent>
              <div className="flex items-center justify-end gap-2 p-4 border-t">
                <Button variant="outline" onClick={() => setShowExportConfirm(false)}>
                  Cancel
                </Button>
                <Button onClick={handleExportConfirm}>
                  Export {filteredMovements.length} Records
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}
      
      {/* Reusable confirmation dialog */}
      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(o) => {
          if (!o) {
            setConfirmDelete(null);
            setConfirmationAnimal(null);
          }
        }}
        title="Delete Movement"
        description={(
          <>
            {confirmDelete !== null && (
              <span className="text-sm text-slate-600">
                {findMovementById(confirmDelete)?.type === MovementType.PRODUCE
                  ? 'This will permanently delete the PRODUCE movement and all related WASTE and ISSUE movements, restoring stock with FIFO integrity.'
                  : 'This will permanently delete the RECEIVE movement and restore stock with FIFO integrity.'}
              </span>
            )}
          </>
        )}
        tokenLabel="Animal"
        token={confirmationAnimal || ''}
        inputPlaceholder="Type the animal exactly as shown"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onConfirm={() => {
          if (confirmDelete !== null) {
            onDeleteMovement?.(confirmDelete);
          }
        }}
      />
    </div>
  );
}
