<script setup lang="ts">
import { computed, ref } from 'vue';
import { cn } from '@/lib/utils';

interface InputProps {
  modelValue?: string | number | null;
  type?: string;
  class?: string;
}

const props = withDefaults(defineProps<InputProps>(), {
  modelValue: '',
  type: 'text',
  class: undefined,
});

const emit = defineEmits<{
  'update:modelValue': [value: string];
}>();

const input = ref<HTMLInputElement | null>(null);

const model = computed(() => String(props.modelValue ?? ''));

/**
 * Vue casts `<input type="number">` v-model values to numbers automatically.
 * Emit the raw string so callers always receive a predictable value type.
 */
function onInput(event: Event) {
  const target = event.target as HTMLInputElement | null;
  emit('update:modelValue', target?.value ?? '');
}

defineExpose({
  focus: () => input.value?.focus(),
  select: () => input.value?.select(),
});
</script>

<template>
  <input
    ref="input"
    :value="model"
    :type="props.type"
    @input="onInput"
    :class="
      cn(
        'flex h-10 w-full rounded-lg border border-input bg-card px-3.5 py-2 text-sm text-foreground shadow-[0_1px_1px_rgba(20,45,34,0.03)] transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/65 focus-visible:border-primary/55 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 dark:shadow-none',
        props.class,
      )
    "
    data-slot="input"
  />
</template>
