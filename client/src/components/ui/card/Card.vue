<script setup lang="ts">
import { cn } from '@/lib/utils';

interface CardProps {
  as?: string;
  class?: string;
}

const props = withDefaults(defineProps<CardProps>(), {
  as: 'div',
  class: undefined,
});
</script>

<template>
  <component
    :is="props.as"
    :class="
      cn(
        'rounded-2xl border border-border bg-card text-card-foreground shadow-[0_1px_2px_rgba(23,18,38,0.035),0_10px_28px_-24px_rgba(15,20,109,0.32)] dark:shadow-[0_1px_2px_rgba(0,0,0,0.3),0_14px_32px_-26px_rgba(0,0,0,0.9)]',
        props.class,
      )
    "
    data-slot="card"
  >
    <slot />
  </component>
</template>
