interface TruthLensLogoProps {
  compact?: boolean;
  variant?: 'light' | 'dark';
}

export function TruthLensLogo({ compact = false, variant = 'light' }: TruthLensLogoProps) {
  const isDark = variant === 'dark';

  return (
    <span className="inline-flex items-center gap-2.5 whitespace-nowrap shrink-0 select-none">
      <svg
        width="28"
        height="28"
        viewBox="0 0 28 28"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        className="shrink-0"
      >
        <defs>
          <linearGradient id="tl-mark-bg" x1="2" y1="2" x2="26" y2="26" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor={isDark ? '#1E1B4B' : '#172554'} />
            <stop offset="100%" stopColor={isDark ? '#4C1D95' : '#2563EB'} />
          </linearGradient>
          <linearGradient id="tl-mark-accent" x1="17" y1="17" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="#93C5FD" />
            <stop offset="100%" stopColor="#C4B5FD" />
          </linearGradient>
        </defs>
        <rect
          x="1.5"
          y="1.5"
          width="25"
          height="25"
          rx="7"
          fill="url(#tl-mark-bg)"
        />
        <circle cx="13.2" cy="13.2" r="5.3" stroke="#FFFFFF" strokeWidth="2" />
        <path
          d="M17.3 17.3L21 21"
          stroke="url(#tl-mark-accent)"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
        <circle cx="13.2" cy="13.2" r="1.9" fill="#A78BFA" />
      </svg>
      {!compact && (
        <span
          className={`font-[var(--font-display)] text-[17px] font-bold tracking-[-0.025em] transition-colors duration-200 ${
            isDark ? 'text-white' : 'text-[#0F172A]'
          }`}
        >
          TruthLens
        </span>
      )}
    </span>
  );
}
