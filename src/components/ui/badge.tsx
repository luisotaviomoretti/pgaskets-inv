import React from 'react';

type Props = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: 'default' | 'secondary' | 'destructive' | 'success' | 'warning';
};

export const Badge: React.FC<Props> = ({ variant = 'default', className = '', ...props }) => {
  const variants: Record<string, string> = {
    default: 'bg-slate-900 text-white',
    secondary: 'bg-slate-100 text-slate-800',
    destructive: 'bg-red-100 text-red-700',
    success: 'bg-green-100 text-green-700',
    warning: 'bg-amber-100 text-amber-700',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${variants[variant] ?? variants.default} ${className}`} {...props} />;
};

export default Badge;
