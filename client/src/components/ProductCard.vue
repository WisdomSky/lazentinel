<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  Clock3,
  ExternalLink,
  Package,
  RefreshCw,
  Trash2,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import PriceChart from '@/components/PriceChart.vue';
import StarRating from '@/components/StarRating.vue';
import {
  formatDrop,
  formatPrice,
  formatRelativeTime,
  formatReviewCount,
} from '@/lib/format';
import type { Product } from '@/lib/types';

interface ProductCardProps {
  product: Product;
  now: number;
  refreshing: boolean;
  deleting: boolean;
}

const props = defineProps<ProductCardProps>();

const emit = defineEmits<{
  refresh: [id: number];
  delete: [id: number];
}>();

const imageFailed = ref(false);

watch(
  () => props.product.imageUrl,
  () => {
    imageFailed.value = false;
  },
);

const hasImage = computed(
  () => Boolean(props.product.imageUrl) && !imageFailed.value,
);

const hasPreviousPrice = computed(
  () =>
    props.product.previousPrice !== null &&
    props.product.currentPrice !== null &&
    props.product.previousPrice !== props.product.currentPrice,
);

const historyCount = computed(() => props.product.history.length);
</script>

<template>
  <Card as="article" class="product-card overflow-hidden">
    <div class="p-4 sm:p-6">
      <div
        class="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between sm:gap-6"
      >
        <div class="flex min-w-0 items-start gap-3.5">
          <div
            class="relative size-14 shrink-0 overflow-hidden rounded-xl border border-border/80 bg-muted/45 sm:size-16"
          >
            <img
              v-if="hasImage && product.imageUrl"
              :src="product.imageUrl"
              :alt="`${product.title} product thumbnail`"
              class="h-full w-full object-cover"
              loading="lazy"
              decoding="async"
              referrerpolicy="no-referrer"
              @error="imageFailed = true"
            />
            <div v-else class="grid h-full w-full place-items-center">
              <Package class="size-6 text-muted-foreground/55" aria-hidden="true" />
            </div>
          </div>

          <div class="min-w-0 flex-1">
            <a
              :href="product.url"
              target="_blank"
              rel="noopener noreferrer"
              class="group inline-flex max-w-full items-start gap-1.5 text-[15px] font-semibold leading-5 tracking-[-0.01em] text-foreground transition-colors hover:text-primary focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45 focus-visible:ring-offset-2 focus-visible:ring-offset-card sm:text-base sm:leading-6"
              :title="product.title"
            >
              <span class="line-clamp-2 break-words">{{ product.title }}</span>
              <ExternalLink
                class="mt-1 size-3.5 shrink-0 text-muted-foreground/65 transition-colors group-hover:text-primary"
                aria-hidden="true"
              />
            </a>

            <div
              class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground"
            >
              <span class="font-semibold text-foreground/85">
                {{ product.brand ?? 'Unbranded' }}
              </span>

              <span class="text-muted-foreground/35" aria-hidden="true">•</span>

              <StarRating :rating="product.rating" />

              <span
                v-if="product.rating !== null"
                class="font-medium tabular-nums text-foreground/70"
              >
                {{ product.rating.toFixed(1) }}
              </span>
              <span v-else>No ratings yet</span>

              <span
                v-if="product.reviewCount !== null"
                class="tabular-nums text-muted-foreground"
              >
                {{ formatReviewCount(product.reviewCount) }}
              </span>

              <Badge
                v-if="product.dropPercent > 0"
                variant="positive"
                class="drop-badge ml-0.5"
              >
                <TrendingDown aria-hidden="true" />
                −{{ formatDrop(product.dropPercent) }}
              </Badge>
              <Badge
                v-else-if="product.dropPercent < 0"
                variant="negative"
                class="drop-badge ml-0.5"
              >
                <TrendingUp aria-hidden="true" />
                +{{ formatDrop(Math.abs(product.dropPercent)) }}
              </Badge>
            </div>
          </div>
        </div>

        <div
          class="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 pt-3 sm:justify-end sm:border-0 sm:pt-0"
        >
          <div class="flex flex-col items-start sm:items-end">
            <span
              class="text-[24px] font-semibold leading-7 tracking-[-0.035em] tabular-nums text-foreground sm:text-[28px]"
              :title="
                product.currentPrice !== null
                  ? formatPrice(product.currentPrice, product.currency)
                  : 'Price unavailable'
              "
            >
              {{
                product.currentPrice !== null
                  ? formatPrice(product.currentPrice, product.currency)
                  : '—'
              }}
            </span>
            <span
              v-if="hasPreviousPrice && product.previousPrice !== null"
              class="mt-0.5 text-[11px] leading-4 tabular-nums text-muted-foreground"
            >
              was
              <span class="line-through">
                {{ formatPrice(product.previousPrice, product.currency) }}
              </span>
            </span>
          </div>

          <div class="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon-sm"
              class="text-muted-foreground hover:text-foreground"
              :disabled="refreshing || deleting"
              :aria-label="refreshing ? 'Checking price now' : 'Check price now'"
              :aria-busy="refreshing"
              :title="refreshing ? 'Checking price…' : 'Check price now'"
              @click="emit('refresh', product.id)"
            >
              <RefreshCw :class="{ 'animate-spin': refreshing }" aria-hidden="true" />
            </Button>

            <Button
              variant="ghost"
              size="icon-sm"
              class="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              :disabled="deleting || refreshing"
              :aria-label="deleting ? 'Deleting product' : 'Delete product'"
              :aria-busy="deleting"
              :title="deleting ? 'Deleting…' : 'Delete product'"
              @click="emit('delete', product.id)"
            >
              <Trash2 :class="{ 'animate-pulse': deleting }" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </div>

      <div
        class="mt-4 rounded-xl border border-border/65 bg-muted/25 p-3 sm:mt-5 sm:p-3.5"
      >
        <div class="mb-1 flex items-center justify-between gap-3 px-0.5">
          <span
            class="text-[10.5px] font-semibold uppercase tracking-[0.15em] text-muted-foreground"
          >
            Price history
          </span>
          <span v-if="historyCount" class="text-[10.5px] tabular-nums text-muted-foreground/75">
            {{ historyCount }} {{ historyCount === 1 ? 'check' : 'checks' }}
          </span>
        </div>

        <PriceChart
          :history="product.history"
          :currency="product.currency"
          :drop-percent="product.dropPercent"
        />
      </div>

      <div
        class="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 px-0.5 text-[11.5px] text-muted-foreground"
      >
        <span class="inline-flex items-center gap-1.5">
          <Clock3 class="size-3.5 text-muted-foreground/70" aria-hidden="true" />
          Last checked {{ formatRelativeTime(product.lastCheckedAt, now) }}
        </span>

        <span
          v-if="product.lowestPrice !== null"
          class="tabular-nums text-muted-foreground/80"
        >
          Lowest {{ formatPrice(product.lowestPrice, product.currency) }}
        </span>
      </div>

      <div
        v-if="product.lastError"
        class="mt-3 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-[11.5px] leading-4 text-foreground/75"
        role="status"
      >
        <TriangleAlert
          class="mt-px size-3.5 shrink-0 text-warning"
          aria-hidden="true"
        />
        <span class="break-words">
          Last check failed: {{ product.lastError }}
          <span class="text-muted-foreground">Retrying automatically.</span>
        </span>
      </div>
    </div>
  </Card>
</template>
