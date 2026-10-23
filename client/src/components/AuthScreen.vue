<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ArrowLeft,
  ChartNoAxesCombined,
  CircleAlert,
  Loader2,
  LockKeyhole,
  Mail,
  Moon,
  Sun,
} from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/composables/useAuth';
import { useTheme } from '@/composables/useTheme';
import { getErrorMessage } from '@/lib/api';

type Mode = 'login' | 'register';

const { isDark, toggleTheme } = useTheme();
const { login, register } = useAuth();

const mode = ref<Mode>('login');
const email = ref('');
const password = ref('');
const confirmPassword = ref('');
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const isRegistering = computed(() => mode.value === 'register');
const heading = computed(() =>
  isRegistering.value ? 'Create your account' : 'Sign in to Lazentinel',
);
const description = computed(() =>
  isRegistering.value
    ? 'Create an account to keep your own private Lazada watchlist.'
    : 'Access your private Lazada watchlist and continue price surveillance.',
);

function switchMode(next: Mode): void {
  mode.value = next;
  password.value = '';
  confirmPassword.value = '';
  error.value = null;
  notice.value = null;
}

function validate(): string | null {
  const address = email.value.trim();
  if (!address) return 'Enter your email address.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
    return 'Enter a valid email address.';
  }
  if (!password.value) return 'Enter your password.';
  if (isRegistering.value) {
    if (!confirmPassword.value) return 'Confirm your password.';
    if (password.value !== confirmPassword.value) {
      return 'Passwords do not match.';
    }
  }
  return null;
}

async function submit(): Promise<void> {
  if (busy.value) return;

  error.value = null;
  notice.value = null;
  const validationError = validate();
  if (validationError) {
    error.value = validationError;
    return;
  }

  busy.value = true;
  try {
    if (isRegistering.value) {
      await register(email.value.trim(), password.value, confirmPassword.value);
      mode.value = 'login';
      password.value = '';
      confirmPassword.value = '';
      notice.value = 'Account created. Sign in to continue.';
    } else {
      await login(email.value.trim(), password.value);
    }
  } catch (submitError) {
    error.value = getErrorMessage(submitError);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="app-canvas flex min-h-dvh flex-col">
    <header class="mx-auto flex h-20 w-full max-w-6xl items-center justify-between px-4 sm:px-6">
      <div class="flex min-w-0 items-center gap-2.5">
        <span class="brand-mark shrink-0" aria-hidden="true">
          <ChartNoAxesCombined class="size-[18px]" />
        </span>
        <div class="min-w-0">
          <p class="truncate text-sm font-semibold tracking-[-0.02em]">
            Lazentinel
          </p>
          <p class="hidden text-[10.5px] text-muted-foreground sm:block">
            Lazada price sentinel
          </p>
        </div>
      </div>

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
    </header>

    <main class="flex flex-1 items-center justify-center px-4 pb-16 pt-4 sm:px-6">
      <div class="w-full max-w-[430px]">
        <div class="mb-5 flex items-center gap-2">
          <span class="size-1.5 rounded-full bg-brand-orange" aria-hidden="true" />
          <span class="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-brand-ink">
            Private price surveillance
          </span>
        </div>

        <Card class="overflow-hidden p-0 shadow-[0_24px_70px_-34px_rgba(15,20,109,0.5)]">
          <div class="border-b border-border/75 px-5 py-5 sm:px-7 sm:py-6">
            <h1 class="text-[22px] font-semibold tracking-[-0.03em] text-foreground">
              {{ heading }}
            </h1>
            <p class="mt-1.5 text-[12.5px] leading-5 text-muted-foreground">
              {{ description }}
            </p>
          </div>

          <form class="space-y-4 px-5 py-5 sm:px-7" novalidate @submit.prevent="submit">
            <div
              v-if="notice"
              class="flex items-start gap-2 rounded-lg border border-positive/25 bg-positive/10 px-3 py-2.5 text-[12.5px] leading-5 text-positive"
              role="status"
              aria-live="polite"
            >
              <span class="mt-0.5 size-1.5 shrink-0 rounded-full bg-positive" aria-hidden="true" />
              <span>{{ notice }}</span>
            </div>

            <div class="space-y-2">
              <Label for="auth-email">Email address</Label>
              <div class="relative">
                <Mail
                  class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                  aria-hidden="true"
                />
                <Input
                  id="auth-email"
                  v-model="email"
                  type="email"
                  inputmode="email"
                  autocomplete="email"
                  autocapitalize="off"
                  spellcheck="false"
                  placeholder="you@example.com"
                  class="pl-10"
                  :disabled="busy"
                  required
                />
              </div>
            </div>

            <div class="space-y-2">
              <Label for="auth-password">Password</Label>
              <div class="relative">
                <LockKeyhole
                  class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                  aria-hidden="true"
                />
                <Input
                  id="auth-password"
                  v-model="password"
                  type="password"
                  :autocomplete="isRegistering ? 'new-password' : 'current-password'"
                  placeholder="Enter your password"
                  class="pl-10"
                  :disabled="busy"
                  required
                />
              </div>
            </div>

            <div v-if="isRegistering" class="space-y-2">
              <Label for="auth-confirm-password">Confirm password</Label>
              <div class="relative">
                <LockKeyhole
                  class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground/70"
                  aria-hidden="true"
                />
                <Input
                  id="auth-confirm-password"
                  v-model="confirmPassword"
                  type="password"
                  autocomplete="new-password"
                  placeholder="Repeat your password"
                  class="pl-10"
                  :disabled="busy"
                  required
                />
              </div>
            </div>

            <div
              v-if="error"
              class="flex items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-[12.5px] leading-5 text-destructive"
              role="alert"
            >
              <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span class="break-words">{{ error }}</span>
            </div>

            <Button type="submit" class="w-full" :disabled="busy">
              <Loader2 v-if="busy" class="animate-spin" aria-hidden="true" />
              <template v-if="busy">
                {{ isRegistering ? 'Creating account…' : 'Signing in…' }}
              </template>
              <template v-else>
                {{ isRegistering ? 'Create account' : 'Sign in' }}
              </template>
            </Button>
          </form>

          <div class="border-t border-border/75 bg-muted/25 px-5 py-4 sm:px-7">
            <template v-if="isRegistering">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <p class="text-[12px] text-muted-foreground">
                  Already have an account?
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  :disabled="busy"
                  @click="switchMode('login')"
                >
                  <ArrowLeft aria-hidden="true" />
                  Back to sign in
                </Button>
              </div>
            </template>
            <template v-else>
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p class="text-[12px] text-muted-foreground">
                  New to Lazentinel?
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  :disabled="busy"
                  @click="switchMode('register')"
                >
                  Create an account
                </Button>
              </div>
            </template>
          </div>
        </Card>

        <p class="mt-5 text-center text-[11px] leading-4 text-muted-foreground">
          Tracking keeps running in the background, even while you are signed out.
        </p>
      </div>
    </main>
  </div>
</template>
