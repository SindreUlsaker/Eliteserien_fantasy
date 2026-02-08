'use client';

import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
const KEY = 'theme';

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Theme | null;
      if (saved === 'light' || saved === 'dark') {
        document.body.dataset.theme = saved;
        setTheme(saved);
      } else {
        // follow system
        setTheme(systemPrefersDark() ? 'dark' : 'light');
      }
    } catch {
      setTheme(systemPrefersDark() ? 'dark' : 'light');
    }
  }, []);

  if (!theme) return null;

  function toggle() {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.body.dataset.theme = next;
    localStorage.setItem(KEY, next);
    setTheme(next);
  }

  return (
    <button
      type="button"
      className="btn btn-ghost theme-toggle"
      onClick={toggle}
      aria-label="Toggle theme"
      title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
    >
      {theme === 'dark' ? '🌙' : '☀️'}
    </button>
  );
}
