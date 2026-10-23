<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'reka-ui';
import { cn } from '@/lib/utils';

interface SwitchProps {
  modelValue?: boolean;
  id?: string;
  disabled?: boolean;
  class?: string;
}

const props = withDefaults(defineProps<SwitchProps>(), {
  modelValue: false,
  id: undefined,
  disabled: false,
  class: undefined,
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
}>();

function onUpdate(value: boolean | 'indeterminate') {
  emit('update:modelValue', value === true);
}
</script>

<template>
  <SwitchRoot
    :id="props.id"
    :model-value="props.modelValue"
    :disabled="props.disabled"
    :class="
      cn(
        'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/55 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-primary',
        props.class,
      )
    "
    data-slot="switch"
    @update:model-value="onUpdate"
  >
    <SwitchThumb
      class="pointer-events-none block size-3.5 translate-x-[3px] rounded-full bg-white shadow-[0_1px_2px_rgba(10,30,22,0.3)] transition-transform duration-200 data-[state=checked]:translate-x-[19px]"
    />
  </SwitchRoot>
</template>
