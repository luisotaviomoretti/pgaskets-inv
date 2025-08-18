// Minimal table primitives styled with Tailwind
import React from 'react';

export const Table: React.FC<React.HTMLAttributes<HTMLTableElement>> = ({ className = '', ...props }) => (
  <table className={`w-full text-sm ${className}`} {...props} />
);

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className = '', ...props }) => (
  <thead className={className} {...props} />
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className = '', ...props }) => (
  <tbody className={className} {...props} />
);

export const TableFooter: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({ className = '', ...props }) => (
  <tfoot className={className} {...props} />
);

export const TableRow: React.FC<React.HTMLAttributes<HTMLTableRowElement>> = ({ className = '', ...props }) => (
  <tr className={`border-b last:border-0 ${className}`} {...props} />
);

export const TableHead: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({ className = '', ...props }) => (
  <th className={`text-left text-slate-500 font-medium py-2 px-3 ${className}`} {...props} />
);

export const TableCell: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({ className = '', ...props }) => (
  <td className={`py-2 px-3 ${className}`} {...props} />
);

export default Table;
