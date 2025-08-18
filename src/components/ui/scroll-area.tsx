import React from 'react';

type Props = React.HTMLAttributes<HTMLDivElement> & { viewportClassName?: string };

export const ScrollArea: React.FC<Props> = ({ className = '', viewportClassName = '', children, ...props }) => (
  <div className={`relative overflow-hidden ${className}`} {...props}>
    <div className={`overflow-auto ${viewportClassName}`}>{children}</div>
  </div>
);

export default ScrollArea;
