import React from 'react';

type Props = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: 'default' | 'secondary';
};

export const Badge: React.FC<Props> = ({ variant = 'default', className = '', ...props }) => {
  const variants: Record<string, string> = {
    default: 'bg-slate-900 text-white',
    secondary: 'bg-slate-100 text-slate-800',
  };
  return <span className={`inline-flex items-center px-2 py-0.5 text-xs rounded-full ${variants[variant]} ${className}`} {...props} />;
};

export default Badge;
