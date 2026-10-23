import { computed, readonly, ref } from 'vue';
import {
  getAuthSession,
  getErrorMessage,
  login as loginRequest,
  logout as logoutRequest,
  register as registerRequest,
} from '@/lib/api';
import type { AuthUser } from '@/lib/types';

const multiUser = ref(false);
const user = ref<AuthUser | null>(null);
const initialized = ref(false);
const initializing = ref(false);
const initializationError = ref<string | null>(null);

let initializePromise: Promise<void> | null = null;
let unauthorizedListenerInstalled = false;

function installUnauthorizedListener(): void {
  if (typeof window === 'undefined' || unauthorizedListenerInstalled) return;
  unauthorizedListenerInstalled = true;
  window.addEventListener('lazentinel:unauthorized', () => {
    user.value = null;
  });
}

async function initialize(): Promise<void> {
  if (initializePromise) return initializePromise;
  if (initialized.value) return;

  initializing.value = true;
  initializationError.value = null;
  initializePromise = (async () => {
    try {
      const session = await getAuthSession();
      multiUser.value = session.multiUser;
      user.value = session.user;
      initialized.value = true;
    } catch (error) {
      initializationError.value = getErrorMessage(error);
    } finally {
      initializing.value = false;
      initializePromise = null;
    }
  })();
  return initializePromise;
}

async function login(email: string, password: string): Promise<void> {
  const response = await loginRequest(email, password);
  user.value = response.user;
  multiUser.value = true;
  initialized.value = true;
  initializationError.value = null;
}

async function register(
  email: string,
  password: string,
  confirmPassword: string,
): Promise<void> {
  await registerRequest(email, password, confirmPassword);
}

async function logout(): Promise<void> {
  try {
    await logoutRequest();
  } finally {
    user.value = null;
  }
}

function markUnauthenticated(): void {
  user.value = null;
}

const canAccess = computed(() => !multiUser.value || user.value !== null);

export function useAuth() {
  installUnauthorizedListener();

  return {
    multiUser: readonly(multiUser),
    user: readonly(user),
    initialized: readonly(initialized),
    initializing: readonly(initializing),
    initializationError: readonly(initializationError),
    canAccess,
    initialize,
    login,
    register,
    logout,
    markUnauthenticated,
  };
}
