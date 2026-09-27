/* Utility math helpers */
export function add(a: number, b: number): number {
  return a + b;
}

export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export const PI_APPROX = 3.14;
