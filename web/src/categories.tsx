// Useful-contact categories. Ids must match server/src/categories.js.
import type { ReactNode } from 'react';

export type CategoryId =
  | 'farmacia' | 'medico' | 'gas' | 'agua' | 'mercado' | 'delivery'
  | 'marido' | 'eletricista' | 'encanador' | 'chaveiro' | 'eletro' | 'outro';

export interface Category { id: CategoryId; label: string; color: string; icon: ReactNode }

export const CATEGORIES: Category[] = [
  { id: 'farmacia', label: 'Farmácia', color: '#3cffb4', icon: <>
    <rect x="2.5" y="8.5" width="19" height="7" rx="3.5" transform="rotate(-45 12 12)" /><path d="m9.5 9.5 5 5" /></> },
  { id: 'medico', label: 'Médico', color: '#ff5c8a', icon: <>
    <path d="M5 3v5a4 4 0 0 0 8 0V3" /><path d="M9 12v3a5 5 0 0 0 10 0v-2" /><circle cx="19" cy="11" r="2" /></> },
  { id: 'gas', label: 'Gás', color: '#ff9f43', icon: <>
    <path d="M9 3h6v3H9z" /><rect x="5.5" y="6" width="13" height="15" rx="4.5" /><path d="M5.5 13h13" /></> },
  { id: 'agua', label: 'Água', color: '#22e4ff', icon: <>
    <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" /><path d="M9.5 14.5a2.5 2.5 0 0 0 2.5 2.5" /></> },
  { id: 'mercado', label: 'Mercado', color: '#ffd84d', icon: <>
    <path d="M3 4h2l2.4 11h10.2L20 8H6.2" /><circle cx="9" cy="19" r="1.5" /><circle cx="17" cy="19" r="1.5" /></> },
  { id: 'delivery', label: 'Delivery', color: '#ff7ad9', icon: <>
    <path d="M5 8h14l-1 12H6z" /><path d="M9 8V6a3 3 0 0 1 6 0v2" /></> },
  { id: 'marido', label: 'Marido de aluguel', color: '#a78bfa', icon: <>
    <rect x="3" y="8" width="18" height="12" rx="2" /><path d="M9 8V5h6v3M3 13h18M10 12v3h4v-3" /></> },
  { id: 'eletricista', label: 'Eletricista', color: '#ffe14d', icon: <>
    <path d="M13 3 5 14h6l-1 7 8-11h-6z" /></> },
  { id: 'encanador', label: 'Encanador', color: '#4da3ff', icon: <>
    <path d="M3 8h9a5 5 0 0 1 5 5v1h-4v-1a1 1 0 0 0-1-1H3z" /><path d="M7.5 8V5M5.5 5h4" /><path d="M15 17.5v.5M15 20.5v.5" /></> },
  { id: 'chaveiro', label: 'Chaveiro', color: '#ffb84d', icon: <>
    <circle cx="8" cy="15" r="4" /><path d="m11 12 9-9M17 6l3 3M14.5 8.5l2 2" /></> },
  { id: 'eletro', label: 'Eletrodomésticos', color: '#9fb4ff', icon: <>
    <rect x="6" y="3" width="12" height="18" rx="2" /><path d="M6 10h12M9 6v2M9 13v3" /></> },
  { id: 'outro', label: 'Outro', color: '#7d8aa6', icon: <>
    <circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></> },
];

const BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));
export function categoryOf(id: string | undefined): Category {
  return BY_ID.get(id as CategoryId) || BY_ID.get('outro')!;
}

export function CategoryIcon({ id }: { id: string | undefined }) {
  return <svg viewBox="0 0 24 24" aria-hidden>{categoryOf(id).icon}</svg>;
}
