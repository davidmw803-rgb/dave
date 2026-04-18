import * as React from 'react';
import { cn } from '@/lib/utils';

type Variant = 'default' | 'outline' | 'ghost';
type Size = 'default' | 'sm' | 'icon';

const variants: Record<Variant, string> = {
  default: 'bg-emerald-500 text-neutral-950 hover:bg-emerald-400',
  outline:
    'border border-neutral-700 bg-transparent text-neutral-200 hover:bg-neutral-800',
  ghost: 'bg-transparent text-neutral-300 hover:bg-neutral-800',
};

const sizes: Record<Size, string> = {
  default: 'h-9 px-3 text-sm',
  sm: 'h-8 px-2 text-xs',
  icon: 'h-8 w-8 text-sm',
};

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'default', size = 'default', ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500',
        variants[variant],
        sizes[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = 'Button';
