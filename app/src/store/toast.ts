import { create } from 'zustand';

interface Toast {
  id: number;
  text: string;
}

export const useToasts = create<{ toasts: Toast[] }>(() => ({ toasts: [] }));

let next = 1;

export function toast(text: string) {
  const id = next++;
  useToasts.setState((s) => ({ toasts: [...s.toasts.filter((t) => t.text !== text), { id, text }] }));
  setTimeout(() => useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200);
}
