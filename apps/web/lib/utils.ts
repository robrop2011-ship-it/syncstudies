import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Compose class names, with later Tailwind utilities winning over earlier ones.
 *
 * The `twMerge` half is what makes `<Button className="bg-surface-2" />` actually
 * override the variant's background instead of producing two competing classes
 * whose winner depends on stylesheet order.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
