<script setup lang="ts">
import { onMounted } from 'vue';
import {
  ChartNoAxesCombined,
  CircleAlert,
  Loader2,
  RefreshCw,
} from 'lucide-vue-next';
import App from '@/App.vue';
import AuthScreen from '@/components/AuthScreen.vue';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useAuth } from '@/composables/useAuth';

const {
  multiUser,
  user,
  initialized,
  initializing,
  initializationError,
  initialize,
} = useAuth();

onMounted(() => {
  void initialize();
});

async function retryInitialization(): Promise<void> {
  await initialize();
}
</script>

<template>
  <div
    v-if="initializationError"
    class="app-canvas flex min-h-dvh items-center justify-center px-4"
  >
    <Card class="w-full max-w-md p-6 sm:p-8">
      <div class="flex items-start gap-3">
        <span
          class="grid size-10 shrink-0 place-items-center rounded-xl bg-destructive/10 text-destructive"
        >
          <CircleAlert class="size-5" aria-hidden="true" />
        </span>
        <div class="min-w-0">
          <h1 class="text-base font-semibold text-foreground">
            Couldn't reach Lazentinel
          </h1>
          <p class="mt-1 text-[12.5px] leading-5 text-muted-foreground">
            {{ initializationError }}
          </p>
        </div>
      </div>
      <Button
        variant="outline"
        class="mt-5"
        :disabled="initializing"
        @click="retryInitialization"
      >
        <RefreshCw :class="{ 'animate-spin': initializing }" aria-hidden="true" />
        {{ initializing ? 'Retrying…' : 'Retry' }}
      </Button>
    </Card>
  </div>

  <div
    v-else-if="!initialized"
    class="app-canvas flex min-h-dvh flex-col items-center justify-center gap-4"
  >
    <span class="brand-mark" aria-hidden="true">
      <ChartNoAxesCombined class="size-[18px]" />
    </span>
    <div class="text-center">
      <p class="text-sm font-semibold tracking-[-0.02em]">Lazentinel</p>
      <p class="mt-1 text-[11.5px] text-muted-foreground">Preparing your watchlist…</p>
    </div>
    <Loader2 class="size-4 animate-spin text-primary" aria-hidden="true" />
  </div>

  <AuthScreen v-else-if="multiUser && !user" />
  <App v-else />
</template>
