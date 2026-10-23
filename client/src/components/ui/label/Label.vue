<script setup lang="ts">
import { Label as LabelPrimitive } from 'reka-ui';
import { cn } from '@/lib/utils';

interface LabelProps {
  for?: string;
  class?: string;
}

const props = withDefaults(defineProps<LabelProps>(), {
  for: undefined,
  class: undefined,
});
</script>

<template>
  <LabelPrimitive
    :for="props.for"
    :class="
      cn(
        'text-[13px] font-medium leading-none text-foreground peer-disabled:cursor-not-allowed peer-disabled:opacity-70',
        props.class,
      )
    "
    data-slot="label"
  >
    <slot />
  </LabelPrimitive>
</template>
