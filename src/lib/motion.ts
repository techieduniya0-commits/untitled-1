/**
 * Unified Apple-inspired motion tokens for TruthLens.
 * One consistent easing curve family, predictable durations, and restrained motion distances
 * across every page, reveal, card, and interactive control.
 */
export const MOTION_EASE = {
  /** Signature Apple fluid deceleration curve */
  apple: [0.22, 1, 0.36, 1] as const,
  /** Crisp micro-interaction settling curve */
  smooth: [0.16, 1, 0.3, 1] as const,
  /** Linear beam / timeline progress */
  linear: 'linear' as const,
};

export const MOTION_DURATION = {
  fast: 0.18,
  base: 0.32,
  slow: 0.52,
} as const;

export const SCROLL_VIEWPORT = {
  once: true,
  amount: 0.05,
} as const;
