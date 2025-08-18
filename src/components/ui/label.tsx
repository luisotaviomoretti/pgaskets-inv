import React from 'react';

type Props = React.LabelHTMLAttributes<HTMLLabelElement>;

export const Label: React.FC<Props> = ({ className = '', ...props }) => (
  <label className={`text-sm font-medium text-slate-700 ${className}`} {...props} />
);

export default Label;
