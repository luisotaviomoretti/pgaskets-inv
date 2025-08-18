import React, { createContext, useContext, useState } from 'react';

type TabsCtx = { value: string; setValue: (v: string) => void };
const Ctx = createContext<TabsCtx | null>(null);

export function Tabs({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) {
  const [inner, setInner] = useState(value ?? '');
  const val = value ?? inner;
  const set = (v: string) => (onValueChange ? onValueChange(v) : setInner(v));
  return <Ctx.Provider value={{ value: val, setValue: set }}><div>{children}</div></Ctx.Provider>;
}

export const TabsList: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...props }) => (
  <div className={`inline-grid gap-2 ${className}`} {...props} />
);

export const TabsTrigger: React.FC<{ value: string } & React.ButtonHTMLAttributes<HTMLButtonElement>> = ({ value, className = '', ...props }) => {
  const ctx = useContext(Ctx)!;
  const active = ctx.value === value;
  return (
    <button
      className={`h-9 px-3 rounded-xl border ${active ? 'bg-slate-900 text-white' : 'bg-white'} ${className}`}
      onClick={() => ctx.setValue(value)}
      {...props}
    />
  );
};

export const TabsContent: React.FC<{ value: string } & React.HTMLAttributes<HTMLDivElement>> = ({ value, className = '', ...props }) => {
  const ctx = useContext(Ctx)!;
  if (ctx.value !== value) return null;
  return <div className={className} {...props} />;
};

export default Tabs;
