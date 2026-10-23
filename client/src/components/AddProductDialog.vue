<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { CircleAlert, Link2, Loader2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from '@/lib/api';
import type { ProductResponse } from '@/lib/types';

interface AddProductDialogProps {
  open: boolean;
  addProduct: (url: string) => Promise<ProductResponse>;
}

const props = defineProps<AddProductDialogProps>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const url = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const urlInput = ref<InstanceType<typeof Input> | null>(null);

const LAZADA_HOST =
  /^(?:[a-z0-9-]+\.)*lazada\.(?:sg|com\.my|co\.th|com\.ph|co\.id|vn)$/i;

function looksLikeLazadaUrl(value: string): boolean {
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  try {
    const parsed = new URL(hasScheme ? value : `https://${value}`);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    return LAZADA_HOST.test(parsed.hostname);
  } catch {
    return false;
  }
}

watch(
  () => props.open,
  async (open) => {
    if (!open) return;

    url.value = '';
    busy.value = false;
    error.value = null;
    await nextTick();
    urlInput.value?.focus();
  },
);

async function submit() {
  if (busy.value) return;

  const value = url.value.trim();
  error.value = null;

  if (!value) {
    error.value = 'Paste a Lazada product link to continue.';
    return;
  }

  if (!looksLikeLazadaUrl(value)) {
    error.value =
      'Enter a valid Lazada product link, for example https://www.lazada.sg/products/….';
    return;
  }

  busy.value = true;
  try {
    const response = await props.addProduct(value);
    busy.value = false;

    if (response.warning) {
      toast.warning('Product added with a note', {
        description: response.warning,
      });
    } else {
      toast.success('Product is now being tracked', {
        description: response.product.title,
      });
    }

    emit('update:open', false);
  } catch (submitError) {
    error.value = getErrorMessage(submitError);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :open="props.open"
    title="Track a Lazada product"
    description="Paste a product URL. We'll read the listing and start keeping its price history."
    :prevent-close="busy"
    @update:open="emit('update:open', $event)"
  >
    <form
      id="add-product-form"
      class="space-y-4"
      novalidate
      @submit.prevent="submit"
    >
      <div class="space-y-2">
        <Label for="product-url">Product URL</Label>
        <div class="relative">
          <Link2
            class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
            aria-hidden="true"
          />
          <Input
            id="product-url"
            ref="urlInput"
            v-model="url"
            type="url"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder="https://www.lazada.sg/products/…"
            class="pl-10"
            :disabled="busy"
            aria-label="Lazada product URL"
            aria-describedby="product-url-help"
          />
        </div>
        <p id="product-url-help" class="text-[11.5px] leading-4 text-muted-foreground">
          Works with Lazada SG, MY, TH, PH, ID and VN links. Loading the live
          price can take up to 30 seconds.
        </p>
      </div>

      <div
        v-if="error"
        class="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[12.5px] leading-5 text-destructive"
        role="alert"
      >
        <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span class="break-words">{{ error }}</span>
      </div>

      <div
        v-if="busy"
        class="flex items-start gap-2.5 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2.5 text-[12.5px] text-foreground/80"
        role="status"
        aria-live="polite"
      >
        <Loader2 class="mt-0.5 size-4 shrink-0 animate-spin text-primary" aria-hidden="true" />
        <span>
          <span class="font-medium text-foreground">Reading product page…</span>
          This can take a little while. Keep this dialog open.
        </span>
      </div>
    </form>

    <template #footer>
      <Button
        variant="outline"
        size="sm"
        :disabled="busy"
        @click="emit('update:open', false)"
      >
        Cancel
      </Button>
      <Button type="submit" form="add-product-form" size="sm" :disabled="busy">
        <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
        {{ busy ? 'Reading…' : 'Start tracking' }}
      </Button>
    </template>
  </Dialog>
</template>
