import { create } from 'zustand';

interface UiStore {
  sidebarOpen: boolean;
  theme: 'light' | 'dark';
  setSidebarOpen: (open: boolean) => void;
  toggleTheme: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  sidebarOpen: false,
  theme: (localStorage.getItem('proxyhub-theme') as 'light' | 'dark' | null) ?? 'light',
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleTheme: () =>
    set((state) => {
      const theme = state.theme === 'light' ? 'dark' : 'light';
      localStorage.setItem('proxyhub-theme', theme);
      return { theme };
    }),
}));
