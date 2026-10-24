import { onMounted, onUnmounted, ref, watch } from 'vue';
import {
  createProduct,
  deleteProduct,
  getErrorMessage,
  getProducts,
  getSettings,
  refreshProduct as refreshProductRequest,
} from '@/lib/api';
import type { Product, ProductResponse, Settings } from '@/lib/types';

const POLL_INTERVAL_MS = 1_000;
const LIVE_STORAGE_KEY = 'lazentinel:live';
const LEGACY_LIVE_STORAGE_KEY = 'lazada-price-tracker:live';

function readLivePreference(): boolean {
  try {
    const stored =
      window.localStorage.getItem(LIVE_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_LIVE_STORAGE_KEY);
    return stored !== 'false';
  } catch {
    return true;
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function sortByBackendOrder(products: Product[]): Product[] {
  return [...products].sort((a, b) => {
    const aDrop = Number.isFinite(a.dropPercent) ? a.dropPercent : 0;
    const bDrop = Number.isFinite(b.dropPercent) ? b.dropPercent : 0;
    return bDrop - aDrop || a.id - b.id;
  });
}

export function useProducts() {
  const products = ref<Product[]>([]);
  const settings = ref<Settings | null>(null);
  const initialLoading = ref(true);
  const loadingError = ref<string | null>(null);
  const pollingError = ref<string | null>(null);
  const live = ref(readLivePreference());
  const now = ref(Date.now());
  const deletingIds = ref<Set<number>>(new Set());
  const refreshingIds = ref<Set<number>>(new Set());

  let isUnmounted = false;
  let pollGeneration = 0;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollController: AbortController | null = null;
  let loadGeneration = 0;
  let loadController: AbortController | null = null;

  function clearPollTimer() {
    if (pollTimer !== null) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function stopPolling() {
    pollGeneration += 1;
    clearPollTimer();
    pollController?.abort();
    pollController = null;
  }

  function cancelLoad() {
    loadController?.abort();
    loadController = null;
  }

  function scheduleNextPoll(token: number) {
    if (token !== pollGeneration || isUnmounted || !live.value) return;

    clearPollTimer();
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll(token);
    }, POLL_INTERVAL_MS);
  }

  async function poll(token: number): Promise<void> {
    if (token !== pollGeneration || isUnmounted || !live.value) return;

    const controller = new AbortController();
    pollController?.abort();
    pollController = controller;

    try {
      const response = await getProducts(controller.signal);
      if (token !== pollGeneration || isUnmounted || !live.value) return;

      products.value = response.products;
      now.value = Date.now();
      pollingError.value = null;
      loadingError.value = null;
    } catch (error) {
      if (
        isAbortError(error) ||
        token !== pollGeneration ||
        isUnmounted ||
        !live.value
      ) {
        return;
      }

      // Keep the last good data; only surface the error without toasting on
      // every tick. The inline banner offers a manual retry.
      pollingError.value = getErrorMessage(error);
      if (!products.value.length) {
        loadingError.value = pollingError.value;
      }
    } finally {
      if (pollController === controller) {
        pollController = null;
      }
    }

    scheduleNextPoll(token);
  }

  function startPolling({ immediate }: { immediate: boolean }) {
    stopPolling();
    if (isUnmounted || !live.value) return;

    const token = pollGeneration;
    if (immediate) {
      void poll(token);
    } else {
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void poll(token);
      }, POLL_INTERVAL_MS);
    }
  }

  function resyncPolling() {
    if (live.value && !initialLoading.value) {
      startPolling({ immediate: true });
    }
  }

  async function loadAll({ showSkeleton }: { showSkeleton: boolean }) {
    cancelLoad();
    stopPolling();

    const request = ++loadGeneration;
    const controller = new AbortController();
    loadController = controller;

    if (showSkeleton) {
      initialLoading.value = true;
    }
    loadingError.value = null;
    pollingError.value = null;

    try {
      const [productsResponse, settingsResponse] = await Promise.all([
        getProducts(controller.signal),
        getSettings(controller.signal),
      ]);

      if (isUnmounted || request !== loadGeneration) return;

      products.value = productsResponse.products;
      settings.value = settingsResponse;
      now.value = Date.now();

      if (live.value) {
        // The initial load just fetched; let the next poll come one second later.
        startPolling({ immediate: false });
      }
    } catch (error) {
      if (
        isAbortError(error) ||
        isUnmounted ||
        request !== loadGeneration
      ) {
        return;
      }

      if (!products.value.length) {
        loadingError.value = getErrorMessage(error);
      }

      // Keep trying quietly if live mode is on, but preserve the error panel.
      if (live.value) {
        startPolling({ immediate: true });
      }
    } finally {
      if (request === loadGeneration) {
        initialLoading.value = false;
        if (loadController === controller) {
          loadController = null;
        }
      }
    }
  }

  function setLive(value: boolean) {
    live.value = value;
  }

  function addToSet(target: typeof deletingIds, id: number) {
    target.value = new Set(target.value).add(id);
  }

  function removeFromSet(target: typeof deletingIds, id: number) {
    const next = new Set(target.value);
    next.delete(id);
    target.value = next;
  }

  async function addProduct(url: string): Promise<ProductResponse> {
    const response = await createProduct(url);
    const next = products.value.filter(
      (product) => product.id !== response.product.id,
    );
    next.push(response.product);
    products.value = sortByBackendOrder(next);

    if (live.value) {
      now.value = Date.now();
      resyncPolling();
    }

    return response;
  }

  async function removeProduct(id: number): Promise<void> {
    addToSet(deletingIds, id);
    try {
      await deleteProduct(id);
      products.value = products.value.filter((product) => product.id !== id);
      resyncPolling();
    } finally {
      removeFromSet(deletingIds, id);
    }
  }

  async function refreshProduct(id: number): Promise<ProductResponse> {
    addToSet(refreshingIds, id);
    try {
      const response = await refreshProductRequest(id);
      products.value = sortByBackendOrder(
        products.value.map((product) =>
          product.id === id ? response.product : product,
        ),
      );

      if (live.value) {
        now.value = Date.now();
        resyncPolling();
      }

      return response;
    } finally {
      removeFromSet(refreshingIds, id);
    }
  }

  async function retry(): Promise<void> {
    if (loadingError.value || !products.value.length) {
      await loadAll({ showSkeleton: !products.value.length });
      return;
    }

    pollingError.value = null;
    startPolling({ immediate: true });
  }

  watch(live, (value) => {
    try {
      window.localStorage.setItem(LIVE_STORAGE_KEY, String(value));
      window.localStorage.removeItem(LEGACY_LIVE_STORAGE_KEY);
    } catch {
      // Private browsing can block storage; the switch still works this session.
    }

    if (isUnmounted) return;

    if (value) {
      if (!initialLoading.value) {
        startPolling({ immediate: true });
      }
    } else {
      stopPolling();
      pollingError.value = null;
    }
  });

  onMounted(() => {
    void loadAll({ showSkeleton: true });
  });

  onUnmounted(() => {
    isUnmounted = true;
    cancelLoad();
    stopPolling();
  });

  return {
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
  };
}
