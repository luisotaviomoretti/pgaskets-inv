import React from 'react';

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'outline' | 'destructive' | 'secondary';
  size?: 'sm' | 'md' | 'lg';
};

export const Button: React.FC<ButtonProps> = ({ variant = 'default', size = 'md', className = '', ...props }) => {
  const base = 'inline-flex items-center justify-center font-medium rounded-xl';
  const sizes: Record<string, string> = { sm: 'h-8 px-3 text-sm', md: 'h-10 px-4', lg: 'h-12 px-5 text-lg' };
  const variants: Record<string, string> = {
    default: 'bg-slate-900 text-white hover:bg-slate-800',
    outline: 'border border-slate-300 hover:bg-slate-50',
    destructive: 'bg-red-600 text-white hover:bg-red-700',
    secondary: 'bg-slate-100 text-slate-800',
  };
  return (
    <button className={`${base} ${sizes[size]} ${variants[variant]} ${className}`} {...props} />
  );
};

export default Button;
