import React from 'react';

type Props = {
  id?: string;
  checked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  className?: string;
};

export const Checkbox: React.FC<Props> = ({ id, checked, onCheckedChange, className = '' }) => {
  return (
    <input
      id={id}
      type="checkbox"
      className={`h-4 w-4 rounded border-slate-300 text-slate-900 ${className}`}
      checked={!!checked}
      onChange={(e) => onCheckedChange?.(e.target.checked)}
    />
  );
};

export default Checkbox;
