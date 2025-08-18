import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  tokenLabel?: string;
  token?: string;
  inputPlaceholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isValid?: (value: string) => boolean;
  onConfirm: () => void;
};

export default function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  tokenLabel = 'Token',
  token = '',
  inputPlaceholder = 'Type the token exactly as shown',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isValid,
  onConfirm,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [value, setValue] = useState('');

  const defaultIsValid = useMemo(() => {
    const normalize = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
    return (v: string) => normalize(v) === normalize(token);
  }, [token]);

  const canConfirm = (isValid ?? defaultIsValid)(value);

  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const input = dialogRef.current?.querySelector('input') as HTMLInputElement | null;
    // reset and focus
    setValue('');
    input?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onOpenChange(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus?.();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" onClick={() => onOpenChange(false)} role="presentation">
      <div className="absolute inset-0 bg-black/40" />
      <div className="absolute inset-0 flex items-center justify-center p-4" onClick={(e) => e.stopPropagation()}>
        <div
          ref={dialogRef}
          className="bg-white rounded-xl shadow-xl w-full max-w-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
        >
          <div className="p-4">
            <h3 id="confirm-dialog-title" className="text-lg font-medium mb-2">{title}</h3>
            {description && (
              <div className="text-sm text-slate-600 mb-3">{description}</div>
            )}
            {(token || tokenLabel) && (
              <div className="text-sm mb-3">
                <div className="inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 bg-slate-50">
                  <span className="text-xs uppercase text-slate-500">{tokenLabel}</span>
                  <span className="font-medium">{token}</span>
                </div>
              </div>
            )}
            <Input
              placeholder={inputPlaceholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              className="h-10"
            />
            <div className="flex gap-2 justify-end mt-4">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {cancelLabel}
              </Button>
              <Button variant="destructive" disabled={!canConfirm} onClick={() => { onConfirm(); onOpenChange(false); }}>
                {confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
