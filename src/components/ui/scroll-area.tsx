import React from 'react';

type Props = React.HTMLAttributes<HTMLDivElement> & { viewportClassName?: string };

export const ScrollArea = React.forwardRef<HTMLDivElement, Props>(
  ({ className = '', viewportClassName = '', children, onScroll, ...rest }, ref) => (
    <div ref={ref} className={`relative ${className}`} {...rest}>
      <div className={`h-full overflow-auto ${viewportClassName}`} onScroll={onScroll}>
        {children}
      </div>
    </div>
  )
);

ScrollArea.displayName = 'ScrollArea';

export default ScrollArea;
