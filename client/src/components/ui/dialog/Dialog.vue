<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';
import { X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';

interface DialogProps {
  open: boolean;
  title: string;
  description: string;
  preventClose?: boolean;
  contentClass?: string;
}

const props = withDefaults(defineProps<DialogProps>(), {
  preventClose: false,
  contentClass: undefined,
});

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

function handleOpenChange(value: boolean) {
  if (!value && props.preventClose) return;
  emit('update:open', value);
}

function preventIfBusy(event: Event) {
  if (props.preventClose) {
    event.preventDefault();
  }
}
</script>

<template>
  <DialogRoot :open="props.open" @update:open="handleOpenChange">
    <DialogPortal>
      <DialogOverlay
        class="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] dark:bg-black/65 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />

      <DialogContent
        :class="
          [
            'fixed left-1/2 top-1/2 z-50 flex max-h-[85dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl border border-border bg-card text-card-foreground shadow-[0_24px_70px_-22px_rgba(23,18,38,0.32),0_2px_8px_rgba(23,18,38,0.06)] dark:shadow-[0_28px_80px_-22px_rgba(0,0,0,0.8),0_2px_8px_rgba(0,0,0,0.4)] focus:outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
            props.contentClass,
          ]
        "
        @escape-key-down="preventIfBusy"
        @pointer-down-outside="preventIfBusy"
        @interact-outside="preventIfBusy"
      >
        <div
          class="flex items-start justify-between gap-4 border-b border-border/75 px-5 py-4 sm:px-6"
        >
          <div class="min-w-0">
            <DialogTitle
              class="text-base font-semibold tracking-[-0.01em] text-foreground"
            >
              {{ props.title }}
            </DialogTitle>
            <DialogDescription class="mt-1 text-[13px] leading-5 text-muted-foreground">
              {{ props.description }}
            </DialogDescription>
          </div>

          <DialogClose as-child>
            <Button
              variant="ghost"
              size="icon-sm"
              class="-mr-1.5 -mt-0.5 shrink-0 text-muted-foreground"
              aria-label="Close dialog"
              :disabled="props.preventClose"
            >
              <X />
            </Button>
          </DialogClose>
        </div>

        <div class="thin-scrollbar flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          <slot />
        </div>

        <div
          v-if="$slots.footer"
          class="flex flex-wrap items-center justify-end gap-2 border-t border-border/75 bg-muted/35 px-5 py-3.5 sm:px-6"
        >
          <slot name="footer" />
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>
