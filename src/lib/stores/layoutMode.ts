import { writable } from 'svelte/store';

export type LayoutMode = 'grid' | 'compact';

const DISPLAY_MODE_KEY = 'videoListDisplayMode';

function getInitialLayout(): LayoutMode {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(DISPLAY_MODE_KEY);
    if (stored === 'compact') return 'compact';
  }
  return 'grid';
}

export const layoutMode = writable<LayoutMode>(getInitialLayout());

if (typeof window !== 'undefined') {
  layoutMode.subscribe((value) => {
    localStorage.setItem(DISPLAY_MODE_KEY, value);
  });
}