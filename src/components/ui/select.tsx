import React, { createContext, useContext } from 'react';

// Very small Select primitives to support the usage pattern in the wireframe
// Usage supported:
// <Select value onValueChange>
//   <SelectTrigger><SelectValue /></SelectTrigger>
//   <SelectContent>
//     <SelectItem value="A">A</SelectItem>
//   </SelectContent>
// </Select>

type SelectCtx = {
  value?: string;
  onValueChange?: (v: string) => void;
};
const Ctx = createContext<SelectCtx>({});

export function Select({ value, onValueChange, children }: { value?: string; onValueChange?: (v: string) => void; children: React.ReactNode }) {
  // Helper to extract plain text from arbitrary ReactNode
  const toText = (node: React.ReactNode): string => {
    if (node === null || node === undefined || node === false) return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(toText).join('');
    if (React.isValidElement(node)) return toText((node.props ?? {}).children);
    return '';
  };

  // Flatten SelectItem children for a basic <select>
  const items: Array<{ value: string; label: string; disabled?: boolean }> = [];
  const walk = (nodes: React.ReactNode) => {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement(child)) return;
      const el = child as React.ReactElement<any>;
      const props = (el.props ?? {}) as any;
      const typeAny = el.type as any;
      if (typeAny?.__isSelectItem) {
        items.push({ value: String(props.value), label: toText(props.children), disabled: !!props.disabled });
      } else if (props?.children) {
        walk(props.children as React.ReactNode);
      }
    });
  };
  walk(children);

  return (
    <Ctx.Provider value={{ value, onValueChange }}>
      <div className="inline-flex items-center gap-2">
        <select
          className="h-10 px-3 rounded-xl border border-slate-300 bg-white"
          value={value}
          onChange={(e) => onValueChange?.(e.target.value)}
        >
          {!value && <option value="" hidden></option>}
          {items.map((it, i) => (
            <option key={i} value={it.value} disabled={!!it.disabled}>{it.label}</option>
          ))}
        </select>
      </div>
    </Ctx.Provider>
  );
}

export const SelectTrigger: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...props }) => (
  <div className={className} {...props} />
);

export const SelectValue: React.FC<{ placeholder?: string }> = ({ placeholder }) => {
  const { value } = useContext(Ctx);
  return <span className="text-slate-500">{value ?? placeholder ?? ''}</span>;
};

export const SelectContent: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({ className = '', ...props }) => (
  <div className={className} {...props} />
);

export const SelectItem: React.FC<{ value: string; disabled?: boolean } & React.HTMLAttributes<HTMLDivElement>> = ({ value, disabled, className = '', ...props }) => {
  return <div data-value={value} data-disabled={disabled ? 'true' : undefined} className={className} {...props} />;
};
(SelectItem as any).__isSelectItem = true;

export default Select;
