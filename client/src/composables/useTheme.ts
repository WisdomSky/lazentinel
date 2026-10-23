import { readonly, ref } from 'vue';

const THEME_STORAGE_KEY = 'lazentinel:theme';
const DARK_THEME_COLOR = '#0d1512';
const LIGHT_THEME_COLOR = '#f8faf8';

type Theme = 'light' | 'dark';

function applyTheme(dark: boolean): void {
  if (typeof document === 'undefined') return;

  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) {
    meta.content = dark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;
  }
}

const isDark = ref(
  typeof document !== 'undefined' &&
    document.documentElement.classList.contains('dark'),
);

if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const handleSystemChange = (event: MediaQueryListEvent) => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    } catch {
      // Storage is optional.
    }
    if (stored === 'light' || stored === 'dark') return;

    isDark.value = event.matches;
    applyTheme(event.matches);
  };

  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', handleSystemChange);
  } else if (typeof media.addListener === 'function') {
    media.addListener(handleSystemChange);
  }
}

export function useTheme() {
  function setTheme(theme: Theme): void {
    isDark.value = theme === 'dark';
    applyTheme(isDark.value);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Private browsing can block storage; the theme still applies this session.
    }
  }

  function toggleTheme(): void {
    setTheme(isDark.value ? 'light' : 'dark');
  }

  return {
    isDark: readonly(isDark),
    setTheme,
    toggleTheme,
  };
}
