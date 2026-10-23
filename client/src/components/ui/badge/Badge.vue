<script setup lang="ts">
import { cva } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 tabular-nums whitespace-nowrap transition-colors [&_svg]:size-3',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border bg-transparent text-muted-foreground',
        positive: 'border-positive/25 bg-positive/10 text-positive',
        negative: 'border-negative/25 bg-negative/10 text-negative',
        warning: 'border-warning/30 bg-warning/10 text-warning',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

interface BadgeProps {
  variant?: 'default' | 'secondary' | 'outline' | 'positive' | 'negative' | 'warning';
  class?: string;
}

const props = withDefaults(defineProps<BadgeProps>(), {
  variant: 'default',
  class: undefined,
});
</script>

<template>
  <span
    :class="cn(badgeVariants({ variant: props.variant }), props.class)"
    data-slot="badge"
  >
    <slot />
  </span>
</template>
