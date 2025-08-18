import React from 'react';

type Props = React.InputHTMLAttributes<HTMLInputElement>;

export const Input = React.forwardRef<HTMLInputElement, Props>(function Input(
  { className = '', ...props }, ref
) {
  return (
    <input ref={ref} className={`h-10 px-3 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400 ${className}`} {...props} />
  );
});

export default Input;
