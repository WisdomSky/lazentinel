<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ChartNoAxesCombined,
  CircleAlert,
  Clock3,
  Loader2,
  Moon,
  PackageSearch,
  PauseCircle,
  Plus,
  RefreshCw,
  Settings,
  Sun,
} from 'lucide-vue-next';
import { Toaster, toast } from 'vue-sonner';
import 'vue-sonner/style.css';
import AddProductDialog from '@/components/AddProductDialog.vue';
import ProductCard from '@/components/ProductCard.vue';
import SettingsDialog from '@/components/SettingsDialog.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from '@/lib/api';
import { formatInterval } from '@/lib/interval';
import { useProducts } from '@/composables/useProducts';
import { useTheme } from '@/composables/useTheme';

const {
  products,
  settings,
  initialLoading,
  loadingError,
  pollingError,
  live,
  now,
  deletingIds,
  refreshingIds,
  setLive,
  addProduct,
  removeProduct,
  refreshProduct,
  saveSettings,
  retry,
} = useProducts();

const { isDark, toggleTheme } = useTheme();
const addDialogOpen = ref(false);
const settingsDialogOpen = ref(false);
const retrying = ref(false);

const productCountLabel = computed(() => {
  const count = products.value.length;
  return `${count} ${count === 1 ? 'product' : 'products'}`;
});

const intervalSummary = computed(() =>
  settings.value
    ? `Checks every ${formatInterval(settings.value.trackingIntervalSeconds)}`
    : 'Check interval loading…',
);

const footerInterval = computed(() =>
  settings.value
    ? `Checks every ${formatInterval(settings.value.trackingIntervalSeconds)}`
    : 'Settings unavailable',
);

async function handleDelete(id: number) {
  try {
    await removeProduct(id);
    toast.success('Product removed', {
      description: 'It is no longer being tracked by the server.',
    });
  } catch (error) {
    toast.error('Could not remove product', {
      description: getErrorMessage(error),
    });
  }
}

async function handleRefresh(id: number) {
  try {
    const response = await refreshProduct(id);

    if (response.warning) {
      toast.warning('Price check finished with a note', {
        description: response.warning,
      });
    } else {
      toast.success('Price check complete', {
        description: response.product.title,
      });
    }
  } catch (error) {
    toast.error('Price check failed', {
      description: getErrorMessage(error),
    });
  }
}

async function handleRetry() {
  retrying.value = true;
  try {
    await retry();
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <div class="app-canvas">
    <header class="site-header sticky top-0 z-40 border-b border-border/70">
      <div
        class="mx-auto flex h-16 w-full max-w-[1120px] items-center justify-between gap-2.5 px-4 sm:px-6"
      >
        <div class="flex min-w-0 items-center gap-2.5">
          <span class="brand-mark shrink-0" aria-hidden="true">
            <ChartNoAxesCombined class="size-[18px]" />
          </span>
          <div class="min-w-0">
            <p
              class="truncate text-[13.5px] font-semibold tracking-[-0.02em] text-foreground sm:text-sm"
            >
              Lazentinel
            </p>
            <p class="hidden text-[10.5px] text-muted-foreground sm:block">
              Lazada price sentinel
            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <Button
            variant="outline"
            size="icon"
            class="rounded-full border-border/65 bg-card/70"
            :aria-label="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            :title="isDark ? 'Switch to light mode' : 'Switch to dark mode'"
            @click="toggleTheme"
          >
            <Sun v-if="isDark" aria-hidden="true" />
            <Moon v-else aria-hidden="true" />
          </Button>

          <div
            class="flex items-center gap-2 rounded-full border border-border/65 bg-card/70 px-2 py-1 sm:px-2.5"
          >
            <span
              class="live-dot"
              :class="{ 'live-dot--paused': !live }"
              aria-hidden="true"
            />
            <Label
              for="live-updates"
              class="hidden cursor-pointer select-none text-[11.5px] font-medium text-muted-foreground transition-colors sm:inline"
            >
              {{ live ? 'Live updates' : 'Paused' }}
            </Label>
            <Switch
              id="live-updates"
              :model-value="live"
              aria-label="Live updates"
              @update:model-value="setLive"
            />
          </div>

          <Button
            variant="outline"
            size="icon"
            class="rounded-full border-border/65 bg-card/70"
            aria-label="Open tracking settings"
            title="Tracking settings"
            @click="settingsDialogOpen = true"
          >
            <Settings aria-hidden="true" />
          </Button>
        </div>
      </div>
    </header>

    <main class="mx-auto w-full max-w-[1120px] px-4 pb-12 sm:px-6">
      <section class="pt-8 sm:pt-10">
        <div
          class="flex flex-col gap-6 md:flex-row md:items-end md:justify-between"
        >
          <div class="max-w-2xl">
            <div
              class="inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-primary"
            >
              <span class="size-1.5 rounded-full bg-primary" aria-hidden="true" />
              Lazada price intelligence
            </div>

            <h1
              class="mt-3 text-[30px] font-semibold leading-[1.08] tracking-[-0.04em] text-foreground sm:text-[40px]"
            >
              Know the moment a Lazada price drops.
            </h1>

            <p
              class="mt-3 max-w-xl text-[13.5px] leading-6 text-muted-foreground sm:text-sm"
            >
              Keep a quiet watchlist of the products you care about. Add a link
              once, then follow every price movement on a clean, live chart.
            </p>
          </div>

          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="lg"
              class="shadow-[0_10px_24px_-14px_rgba(5,120,87,0.75)]"
              @click="addDialogOpen = true"
            >
              <Plus aria-hidden="true" />
              Add product
            </Button>
          </div>
        </div>

        <div
          class="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] text-muted-foreground"
        >
          <span class="font-medium text-foreground/70">
            {{ productCountLabel }} tracked
          </span>
          <span class="hidden text-muted-foreground/35 sm:inline" aria-hidden="true">•</span>
          <span class="inline-flex items-center gap-1.5">
            <Clock3 class="size-3.5 text-muted-foreground/70" aria-hidden="true" />
            {{ intervalSummary }}
          </span>
          <span class="hidden text-muted-foreground/35 sm:inline" aria-hidden="true">•</span>
          <span class="inline-flex items-center gap-1.5">
            <span
              class="live-dot"
              :class="{ 'live-dot--paused': !live }"
              aria-hidden="true"
            />
            {{ live ? 'Updating live' : 'Updates paused' }}
          </span>
        </div>
      </section>

      <div
        v-if="!live"
        class="mt-5 flex flex-col gap-3 rounded-xl border border-border/75 bg-card/70 px-4 py-3 shadow-[0_1px_2px_rgba(20,45,34,0.03)] sm:flex-row sm:items-center sm:justify-between"
        role="status"
        aria-live="polite"
      >
        <div class="flex items-start gap-3">
          <span
            class="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground"
          >
            <PauseCircle class="size-4" aria-hidden="true" />
          </span>
          <div>
            <p class="text-[12.5px] font-medium text-foreground">
              Live updates are paused
            </p>
            <p class="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">
              Charts and card ordering are frozen in this tab. The server keeps
              tracking prices in the background.
            </p>
          </div>
        </div>

        <Button
          variant="outline"
          size="sm"
          class="self-start sm:self-auto"
          @click="setLive(true)"
        >
          Resume updates
        </Button>
      </div>

      <div class="mt-6">
        <div
          v-if="initialLoading"
          class="product-list"
          aria-busy="true"
          aria-label="Loading tracked products"
        >
          <Card
            v-for="index in 2"
            :key="index"
            class="overflow-hidden p-4 sm:p-6"
            aria-hidden="true"
          >
            <div class="flex items-start gap-3.5">
              <Skeleton class="size-14 shrink-0 rounded-xl sm:size-16" />
              <div class="min-w-0 flex-1 space-y-2.5 pt-0.5">
                <Skeleton class="h-4 w-3/5" />
                <Skeleton class="h-3 w-2/5" />
              </div>
              <div class="hidden shrink-0 space-y-2 sm:block">
                <Skeleton class="ml-auto h-7 w-24" />
                <Skeleton class="ml-auto h-3 w-16" />
              </div>
            </div>
            <Skeleton class="mt-5 h-[210px] w-full rounded-xl" />
            <div class="mt-4 flex items-center justify-between gap-4">
              <Skeleton class="h-3 w-32" />
              <Skeleton class="h-3 w-20" />
            </div>
          </Card>
        </div>

        <Card
          v-else-if="loadingError && !products.length"
          class="border-destructive/20 p-5 sm:p-8"
          role="alert"
        >
          <div class="flex flex-col gap-4 sm:flex-row sm:items-start">
            <span
              class="grid size-11 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive"
            >
              <CircleAlert class="size-5" aria-hidden="true" />
            </span>
            <div class="min-w-0 flex-1">
              <h2 class="text-base font-semibold text-foreground">
                Couldn't load your price list
              </h2>
              <p class="mt-1 text-[12.5px] leading-5 text-muted-foreground">
                {{ loadingError }}
              </p>
              <p class="mt-1 text-[11.5px] leading-4 text-muted-foreground/80">
                Check that the API server is running and reachable, then try
                again.
              </p>
              <Button
                variant="outline"
                size="sm"
                class="mt-4"
                :disabled="retrying"
                @click="handleRetry"
              >
                <RefreshCw
                  :class="{ 'animate-spin': retrying }"
                  aria-hidden="true"
                />
                {{ retrying ? 'Retrying…' : 'Retry' }}
              </Button>
            </div>
          </div>
        </Card>

        <section
          v-else-if="!products.length"
          class="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card/55 px-6 py-12 text-center shadow-[0_10px_30px_-28px_rgba(20,45,34,0.3)] sm:py-14"
        >
          <span
            class="grid size-12 place-items-center rounded-2xl border border-border/70 bg-card text-muted-foreground shadow-[0_1px_2px_rgba(20,45,34,0.04)]"
          >
            <PackageSearch class="size-5" aria-hidden="true" />
          </span>
          <h2 class="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            No products on your watchlist yet
          </h2>
          <p class="mt-1.5 max-w-sm text-[12.5px] leading-5 text-muted-foreground">
            Add a Lazada product link and we'll start recording its price right
            away. Drop alerts and history appear as checks come in.
          </p>
          <Button class="mt-5" size="sm" @click="addDialogOpen = true">
            <Plus aria-hidden="true" />
            Add your first product
          </Button>
        </section>

        <template v-else>
          <div
            v-if="pollingError"
            class="mb-4 flex flex-col gap-2 rounded-xl border border-warning/30 bg-warning/10 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
            role="status"
            aria-live="polite"
          >
            <div class="flex items-start gap-2.5">
              <CircleAlert
                class="mt-0.5 size-4 shrink-0 text-warning"
                aria-hidden="true"
              />
              <div>
                <p class="text-[12.5px] font-medium text-foreground">
                  Live updates were interrupted
                </p>
                <p class="mt-0.5 text-[11.5px] leading-4 text-muted-foreground">
                  {{ pollingError }} Showing the most recent data while we keep
                  retrying.
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              class="self-start sm:self-auto"
              :disabled="retrying"
              @click="handleRetry"
            >
              <Loader2
                v-if="retrying"
                class="animate-spin"
                aria-hidden="true"
              />
              <RefreshCw v-else aria-hidden="true" />
              Retry now
            </Button>
          </div>

          <TransitionGroup
            tag="div"
            name="product-list"
            class="product-list"
            appear
          >
            <ProductCard
              v-for="product in products"
              :key="product.id"
              :product="product"
              :now="now"
              :refreshing="refreshingIds.has(product.id)"
              :deleting="deletingIds.has(product.id)"
              @refresh="handleRefresh"
              @delete="handleDelete"
            />
          </TransitionGroup>
        </template>
      </div>

      <footer
        class="mt-10 flex flex-col gap-2 border-t border-border/60 pt-5 text-[11px] leading-4 text-muted-foreground sm:flex-row sm:items-center sm:justify-between"
      >
        <p>Lazentinel is not affiliated with Lazada. Prices are read from public product pages.</p>
        <p class="inline-flex items-center gap-1.5 tabular-nums">
          <Clock3 class="size-3.5 text-muted-foreground/70" aria-hidden="true" />
          {{ footerInterval }}
          <Badge variant="outline" class="ml-1 px-1.5 py-0 text-[10px]">
            Server-side
          </Badge>
        </p>
      </footer>
    </main>

    <AddProductDialog
      :open="addDialogOpen"
      :add-product="addProduct"
      @update:open="addDialogOpen = $event"
    />

    <SettingsDialog
      :open="settingsDialogOpen"
      :interval-seconds="settings?.trackingIntervalSeconds ?? null"
      :save-interval="saveSettings"
      @update:open="settingsDialogOpen = $event"
    />

    <Toaster
      position="bottom-right"
      :theme="isDark ? 'dark' : 'light'"
      :close-button="true"
      :duration="4500"
      :toast-options="{ closeButtonAriaLabel: 'Close notification' }"
    />
  </div>
</template>
