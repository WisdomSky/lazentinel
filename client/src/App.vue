<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  ChartNoAxesCombined,
  ChevronDown,
  CircleAlert,
  Clock3,
  Loader2,
  LogOut,
  Moon,
  PackageSearch,
  PauseCircle,
  Plus,
  RefreshCw,
  Sun,
} from 'lucide-vue-next';
import { Toaster, toast } from 'vue-sonner';
import 'vue-sonner/style.css';
import AddProductDialog from '@/components/AddProductDialog.vue';
import ProductCard from '@/components/ProductCard.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { getErrorMessage } from '@/lib/api';
import { formatInterval } from '@/lib/interval';
import { useAuth } from '@/composables/useAuth';
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
  retry,
} = useProducts();

const { isDark, toggleTheme } = useTheme();
const {
  multiUser: authMultiUser,
  user: authUser,
  logout,
} = useAuth();
const addDialogOpen = ref(false);
const retrying = ref(false);
const userMenuOpen = ref(false);
const userMenuRef = ref<HTMLElement | null>(null);

const userInitial = computed(
  () => authUser.value?.email.trim().charAt(0).toUpperCase() || '?',
);

function handleDocumentPointerDown(event: PointerEvent) {
  if (!userMenuOpen.value) return;
  const target = event.target;
  if (target instanceof Node && userMenuRef.value?.contains(target)) return;
  userMenuOpen.value = false;
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && userMenuOpen.value) {
    userMenuOpen.value = false;
  }
}

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown);
  document.addEventListener('keydown', handleDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown);
  document.removeEventListener('keydown', handleDocumentKeydown);
});

const productCountLabel = computed(() => {
  const count = products.value.length;
  return `${count}`;
});

const intervalSummary = computed(() =>
  settings.value
    ? `Checks every ${formatInterval(settings.value.trackingIntervalSeconds)}`
    : 'Check interval loading…',
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

async function handleSignOut() {
  userMenuOpen.value = false;
  try {
    await logout();
  } catch (error) {
    toast.error('Could not sign out', {
      description: getErrorMessage(error),
    });
  }
}
</script>

<style lang="scss" >

  #live-updates {
    &[data-state="checked"] {
      background-color: var(--live) !important;
    }
  }

  .user-menu-enter-active,
  .user-menu-leave-active {
    transition:
      opacity 140ms ease,
      transform 160ms cubic-bezier(0.16, 1, 0.3, 1);
  }

  .user-menu-enter-from,
  .user-menu-leave-to {
    opacity: 0;
    transform: translateY(-4px) scale(0.98);
  }

</style>

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

            </p>
          </div>
        </div>

        <div class="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <Button
            id="theme-selector"
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

          <div
            v-if="authMultiUser && authUser"
            ref="userMenuRef"
            class="relative"
          >
            <button
              type="button"
              class="flex h-9 items-center gap-1.5 rounded-full border border-border/65 bg-card/70 pl-1 pr-2 text-[11.5px] font-medium text-muted-foreground transition-colors hover:border-primary/30 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
              aria-haspopup="menu"
              :aria-expanded="userMenuOpen"
              :aria-label="`Account menu for ${authUser.email}`"
              :title="authUser.email"
              @click="userMenuOpen = !userMenuOpen"
            >
              <span
                class="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-[11px] font-semibold uppercase leading-none text-primary-foreground"
                aria-hidden="true"
              >
                {{ userInitial }}
              </span>
              <ChevronDown
                class="size-3.5 shrink-0 text-muted-foreground/80 transition-transform duration-150"
                :class="{ 'rotate-180': userMenuOpen }"
                aria-hidden="true"
              />
            </button>

            <Transition name="user-menu">
              <div
                v-if="userMenuOpen"
                class="absolute right-0 top-[calc(100%+0.45rem)] z-50 w-60 rounded-xl border border-border/75 bg-card p-1.5 shadow-[0_18px_40px_-22px_rgba(15,20,109,0.38)]"
                role="menu"
                aria-label="Account menu"
              >
                <div class="px-2.5 pb-2 pt-1.5">
                  <p
                    class="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
                  >
                    Signed in as
                  </p>
                  <p class="mt-1 truncate text-[12.5px] font-medium text-foreground">
                    {{ authUser.email }}
                  </p>
                </div>
                <div class="my-1 h-px bg-border/70" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  class="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
                  @click="handleSignOut"
                >
                  <LogOut class="size-3.5" aria-hidden="true" />
                  Sign out
                </button>
              </div>
            </Transition>
          </div>
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
              class="inline-flex items-center gap-2 text-[10.5px] font-semibold uppercase tracking-[0.18em] text-brand-ink"
            >
              <span class="size-1.5 rounded-full bg-brand-orange" aria-hidden="true" />
              24/7 product price trend surveillance
            </div>

<!--            <h1-->
<!--              class="mt-3 text-[30px] font-semibold leading-[1.08] tracking-[-0.04em] text-foreground sm:text-[40px]"-->
<!--            >-->
<!--              Know the moment a Lazada price drops.-->
<!--            </h1>-->

<!--            <p-->
<!--              class="mt-3 max-w-xl text-[13.5px] leading-6 text-muted-foreground sm:text-sm"-->
<!--            >-->
<!--                aaaa-->
<!--            </p>-->
          </div>

          <div class="flex shrink-0 flex-wrap items-center gap-2">
            <Button
              size="lg"
              class="shadow-[0_10px_24px_-14px_rgba(245,0,136,0.6)] text-white font-bold"
              @click="addDialogOpen = true"
            >
              <Plus aria-hidden="true" />
               Add
            </Button>
          </div>
        </div>

        <div
          class="mt-6 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11.5px] text-muted-foreground"
        >
          <span class="font-medium text-foreground/70">
            {{ productCountLabel }} watched
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
        class="mt-5 flex flex-col gap-3 rounded-xl border border-border/75 bg-card/70 px-4 py-3 shadow-[0_1px_2px_rgba(23,18,38,0.03)] sm:flex-row sm:items-center sm:justify-between"
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
          class="flex flex-col items-center rounded-2xl border border-dashed border-border bg-card/55 px-6 py-12 text-center shadow-[0_10px_30px_-28px_rgba(15,20,109,0.3)] sm:py-14"
        >
          <span
            class="grid size-12 place-items-center rounded-2xl border border-border/70 bg-card text-muted-foreground shadow-[0_1px_2px_rgba(23,18,38,0.04)]"
          >
            <PackageSearch class="size-5" aria-hidden="true" />
          </span>
          <h2 class="mt-4 text-[15px] font-semibold tracking-[-0.01em] text-foreground">
            No products on your watchlist yet
          </h2>
          <p class="mt-1.5 max-w-sm text-[12.5px] leading-5 text-muted-foreground">
            Add a Lazada product link to start price surveillance
          </p>
          <Button class="mt-5 text-white font-bold" size="sm" @click="addDialogOpen = true">
            <Plus aria-hidden="true" />
            Add Product to Watchlist
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
          <a href="https://paodayag.dev">paodayag.dev</a>
        </p>
      </footer>
    </main>

    <AddProductDialog
      :open="addDialogOpen"
      :add-product="addProduct"
      @update:open="addDialogOpen = $event"
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
