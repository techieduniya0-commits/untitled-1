import { type MouseEvent, type ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { MOTION_DURATION, MOTION_EASE, SCROLL_VIEWPORT } from '../lib/motion';

interface PremiumButtonProps {
  variant: 'primary' | 'secondary';
  children: ReactNode;
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  href?: string;
  size?: 'md' | 'lg';
  disabled?: boolean;
  className?: string;
}

/**
 * Apple-inspired luminous button for primary & secondary TruthLens CTAs.
 * Updates cursor sheen via CSS variables directly on the DOM node (zero React re-renders
 * on pointer movement) for silky 60/120Hz responsiveness on all devices.
 */
export function PremiumButton({
  variant,
  children,
  onClick,
  href,
  size = 'lg',
  disabled = false,
  className = '',
}: PremiumButtonProps) {
  const handleMove = (e: MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    el.style.setProperty('--mx', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
  };

  const isPrimary = variant === 'primary';
  const sizeClasses =
    size === 'lg' ? 'px-6 py-3 text-[14px] rounded-xl' : 'px-4 py-2 text-[13px] rounded-lg';

  const baseClasses = `group relative isolate inline-flex items-center justify-center gap-2.5 font-medium overflow-hidden whitespace-nowrap shrink-0 cursor-pointer select-none transition-[transform,box-shadow,border-color,color,background-color] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED] focus-visible:ring-offset-2 focus-visible:ring-offset-white hover:-translate-y-0.5 active:translate-y-0 active:scale-[0.985] disabled:opacity-50 disabled:pointer-events-none ${sizeClasses} ${
    isPrimary
      ? 'text-white border border-[#4338CA]/20 shadow-[0_6px_20px_-6px_rgba(37,99,235,0.28)] hover:border-[#8B5CF6]/55 hover:shadow-[0_14px_32px_-8px_rgba(124,58,237,0.4),0_6px_16px_-4px_rgba(59,130,246,0.28)]'
      : 'text-[#172554] bg-white/88 border border-[#CBDDF8] shadow-[0_2px_10px_-4px_rgba(30,58,138,0.08)] hover:bg-white hover:text-[#4C1D95] hover:border-[#A78BFA]/70 hover:shadow-[0_12px_26px_-10px_rgba(124,58,237,0.22),0_4px_12px_-4px_rgba(96,165,250,0.22)]'
  } ${className}`;

  const innerContent = (
    <>
      {isPrimary && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 transition-[background-position] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] bg-[length:220%_220%] bg-[position:0%_50%] group-hover:bg-[position:100%_50%]"
          style={{
            backgroundImage:
              'linear-gradient(115deg, #172554 0%, #2563EB 44%, #7C3AED 78%, #6D28D9 100%)',
          }}
        />
      )}

      {!isPrimary && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          style={{
            background:
              'linear-gradient(120deg, rgba(239, 246, 255, 0.85) 0%, rgba(243, 240, 255, 0.9) 100%)',
          }}
        />
      )}

      {/* Zero-re-render CSS-variable cursor reflection */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-0 ${
          isPrimary ? 'tl-btn-sheen-primary' : 'tl-btn-sheen-secondary'
        }`}
      />

      {/* Specular diagonal light sweep across button face on hover */}
      <span
        aria-hidden="true"
        className={`pointer-events-none absolute inset-y-0 -left-2/3 w-1/2 -skew-x-12 opacity-0 transition-[left,opacity] duration-500 ease-out group-hover:left-[135%] group-hover:opacity-100 ${
          isPrimary
            ? 'bg-gradient-to-r from-transparent via-white/30 to-transparent'
            : 'bg-gradient-to-r from-transparent via-[#C4B5FD]/35 to-transparent'
        }`}
      />

      <span className="relative z-10 inline-flex items-center gap-2.5">{children}</span>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        onClick={onClick}
        onMouseMove={handleMove}
        className={baseClasses}
      >
        {innerContent}
      </a>
    );
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      onMouseMove={handleMove}
      className={baseClasses}
    >
      {innerContent}
    </button>
  );
}

interface GlassCardProps {
  children: ReactNode;
  className?: string;
  interactive?: boolean;
}

/**
 * Apple-inspired frosted glass card with zero-re-render CSS-variable cursor sheen.
 */
export function GlassCard({ children, className = '', interactive = true }: GlassCardProps) {
  const handleMove = (e: MouseEvent<HTMLDivElement>) => {
    if (!interactive) return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    el.style.setProperty('--mx', `${(((e.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`);
    el.style.setProperty('--my', `${(((e.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`);
  };

  return (
    <div
      onMouseMove={interactive ? handleMove : undefined}
      className={`relative overflow-hidden rounded-2xl tl-glass-panel ${
        interactive ? 'tl-glass-panel-hover' : ''
      } ${className}`}
    >
      {interactive && <div aria-hidden="true" className="pointer-events-none absolute inset-0 tl-card-sheen" />}
      <div className="relative z-10 h-full">{children}</div>
    </div>
  );
}

interface ScrollRevealProps {
  children: ReactNode;
  delay?: number;
  className?: string;
}

/**
 * Lightweight, responsive scroll-reveal wrapper using short durations and small travel
 * so jumping between landing sections never feels delayed or sluggish.
 */
export function ScrollReveal({ children, delay = 0, className = '' }: ScrollRevealProps) {
  const prefersReducedMotion = Boolean(useReducedMotion());

  if (prefersReducedMotion) {
    return <div className={className}>{children}</div>;
  }

  const cappedDelay = Math.min(delay, 0.12);

  return (
    <motion.div
      data-scroll-reveal="true"
      initial={{ opacity: 0, y: 10 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={SCROLL_VIEWPORT}
      transition={{
        duration: MOTION_DURATION.base,
        delay: cappedDelay,
        ease: MOTION_EASE.apple,
      }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
