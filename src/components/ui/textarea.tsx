import React from 'react';

type Props = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, Props>(function Textarea(
  { className = '', ...props }, ref
) {
  return (
    <textarea ref={ref} className={`min-h-[80px] w-full px-3 py-2 rounded-xl border border-slate-300 focus:outline-none focus:ring-2 focus:ring-slate-400 ${className}`} {...props} />
  );
});

export default Textarea;
