import React from 'react';

type DivProps = React.HTMLAttributes<HTMLDivElement>;

export function Card({ className = '', ...props }: DivProps) {
  return <div className={`rounded-xl border ${className}`} {...props} />;
}

export function CardHeader({ className = '', ...props }: DivProps) {
  return <div className={`p-4 border-b ${className}`} {...props} />;
}

export function CardTitle({ className = '', ...props }: DivProps) {
  return <div className={`text-base font-semibold ${className}`} {...props} />;
}

export function CardContent({ className = '', ...props }: DivProps) {
  return <div className={`p-4 ${className}`} {...props} />;
}

export default Card;
