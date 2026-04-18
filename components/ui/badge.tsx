import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'success' | 'danger' | 'neutral' | 'warning';

const variants: Record<Variant, string> = {
  default: 'bg-neutral-800 text-neutral-200',
  success: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  danger: 'bg-red-500/15 text-red-400 border border-red-500/30',
  neutral: 'bg-neutral-700/50 text-neutral-300 border border-neutral-700',
  warning: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export const Badge = React.forwardRef<HTMLSpanElement, BadgeProps>(
  ({ className, variant = 'default', ...props }, ref) => (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium',
        variants[variant],
        className
      )}
      {...props}
    />
  )
);
Badge.displayName = 'Badge';
