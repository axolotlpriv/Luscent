/** Which top-level screen is showing. */
import { create } from 'zustand';

export type Screen = 'home' | 'editor';

interface AppState {
  screen: Screen;
  setScreen(s: Screen): void;
}

export const useApp = create<AppState>((set) => ({
  screen: 'home',
  setScreen: (screen) => set({ screen }),
}));
