// Contact categories (useful numbers for a kitchen/home). The web app keeps
// the labels and icons; the server only validates the id.
export const CATEGORIES = [
  'farmacia', 'medico', 'gas', 'agua', 'mercado', 'delivery',
  'marido', 'eletricista', 'encanador', 'chaveiro', 'eletro', 'outro',
];
export const DEFAULT_CATEGORY = 'outro';

// undefined/empty -> default; unknown -> null (rejected)
export function cleanCategory(input) {
  if (input === undefined || input === null || input === '') return DEFAULT_CATEGORY;
  return typeof input === 'string' && CATEGORIES.includes(input) ? input : null;
}
