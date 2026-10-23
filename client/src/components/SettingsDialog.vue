<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { CircleAlert, Clock3, Loader2 } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getErrorMessage } from '@/lib/api';
import {
  formatInterval,
  isValidTrackingInterval,
  MAX_TRACKING_INTERVAL_SECONDS,
  MIN_TRACKING_INTERVAL_SECONDS,
} from '@/lib/interval';

interface SettingsDialogProps {
  open: boolean;
  intervalSeconds: number | null;
  saveInterval: (seconds: number) => Promise<unknown>;
}

const props = defineProps<SettingsDialogProps>();

const emit = defineEmits<{
  'update:open': [value: boolean];
}>();

const presets = [30, 60, 300, 900, 3600] as const;

const intervalInput = ref('');
const busy = ref(false);
const error = ref<string | null>(null);
const intervalInputEl = ref<InstanceType<typeof Input> | null>(null);

const parsedInterval = computed(() => {
  const trimmed = String(intervalInput.value ?? '').trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
});

const isValid = computed(
  () =>
    parsedInterval.value !== null &&
    isValidTrackingInterval(parsedInterval.value),
);

const isUnchanged = computed(
  () =>
    props.intervalSeconds !== null &&
    parsedInterval.value === props.intervalSeconds,
);

watch(
  () => props.open,
  async (open) => {
    if (!open) return;

    intervalInput.value =
      props.intervalSeconds !== null ? String(props.intervalSeconds) : '';
    busy.value = false;
    error.value = null;
    await nextTick();
    intervalInputEl.value?.focus();
  },
);

function selectPreset(seconds: number) {
  intervalInput.value = String(seconds);
  error.value = null;
}

async function save() {
  if (busy.value) return;

  error.value = null;

  if (!isValid.value || parsedInterval.value === null) {
    error.value = `Enter a whole number of seconds between ${MIN_TRACKING_INTERVAL_SECONDS} and ${MAX_TRACKING_INTERVAL_SECONDS}.`;
    return;
  }

  const value = parsedInterval.value;

  if (isUnchanged.value) {
    toast.info('Tracking interval unchanged', {
      description: `Prices are still checked every ${formatInterval(value)}.`,
    });
    emit('update:open', false);
    return;
  }

  busy.value = true;
  try {
    await props.saveInterval(value);
    toast.success('Tracking interval updated', {
      description: `The server will check prices every ${formatInterval(value)}.`,
    });
    emit('update:open', false);
  } catch (saveError) {
    error.value = getErrorMessage(saveError);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <Dialog
    :open="props.open"
    title="Tracking settings"
    description="Choose how often the server checks your products for price changes."
    @update:open="emit('update:open', $event)"
  >
    <form id="settings-form" class="space-y-5" novalidate @submit.prevent="save">
      <div class="space-y-2.5">
        <div class="flex items-center justify-between gap-3">
          <Label for="tracking-interval">Check every</Label>
          <span
            v-if="props.intervalSeconds !== null"
            class="text-[11px] tabular-nums text-muted-foreground"
          >
            Current: {{ formatInterval(props.intervalSeconds) }}
          </span>
        </div>

        <div
          class="grid grid-cols-5 gap-1.5"
          role="group"
          aria-label="Quick interval presets"
        >
          <button
            v-for="preset in presets"
            :key="preset"
            type="button"
            class="settings-preset rounded-md border border-border bg-card px-1 py-1.5 text-[11.5px] font-medium tabular-nums text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 disabled:cursor-not-allowed disabled:opacity-50"
            :aria-pressed="parsedInterval === preset"
            :disabled="busy"
            @click="selectPreset(preset)"
          >
            {{ formatInterval(preset) }}
          </button>
        </div>

        <div class="relative">
          <Input
            id="tracking-interval"
            ref="intervalInputEl"
            v-model="intervalInput"
            type="number"
            inputmode="numeric"
            min="5"
            max="86400"
            step="1"
            placeholder="300"
            class="pr-20 tabular-nums"
            :disabled="busy"
            aria-label="Tracking interval in seconds"
            aria-describedby="tracking-interval-help"
          />
          <span
            class="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[11.5px] text-muted-foreground"
          >
            seconds
          </span>
        </div>

        <p
          id="tracking-interval-help"
          class="text-[11.5px] leading-4 text-muted-foreground"
        >
          Minimum {{ MIN_TRACKING_INTERVAL_SECONDS }} seconds. This controls the
          server-side tracking cadence; the dashboard itself refreshes live data
          every second.
        </p>
      </div>

      <div
        class="flex items-start gap-2 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5 text-[11.5px] leading-4 text-muted-foreground"
      >
        <Clock3 class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          Lazada prices can fluctuate during flash sales. Shorter intervals give
          you a finer history, at the cost of more frequent checks.
        </span>
      </div>

      <div
        v-if="error"
        class="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[12.5px] leading-5 text-destructive"
        role="alert"
      >
        <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span class="break-words">{{ error }}</span>
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
      <Button type="submit" form="settings-form" size="sm" :disabled="busy">
        <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
        {{ busy ? 'Saving…' : 'Save settings' }}
      </Button>
    </template>
  </Dialog>
</template>
