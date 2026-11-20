/**
 * Consistent global pale-blue and pure-white mixed atmospheric gradient.
 * Uses pure radial gradients (zero expensive CSS filter: blur(120px) passes) so
 * compositing stays silky at 60/120Hz on low-power laptops, tablets, and phones
 * while preserving the exact white + pale-blue + whisper-of-lavender aesthetic.
 */
export function GlobalAmbientCanvas() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0 overflow-hidden select-none"
      style={{
        contain: 'strict',
        background:
          'linear-gradient(150deg, #FFFFFF 0%, #F4F9FF 34%, #EAF3FF 68%, #F3F7FF 100%)',
      }}
    >
      {/* Top-Left Calm Pale-Blue Atmospheric Wash (soft Gaussian-like gradient, no blur filter) */}
      <div
        className="absolute -top-[22%] -left-[14%] w-[72vw] h-[72vw] max-w-[980px] max-h-[980px] rounded-full animate-ambient-primary"
        style={{
          background:
            'radial-gradient(circle, rgba(186, 220, 255, 0.44) 0%, rgba(219, 234, 254, 0.24) 38%, rgba(238, 246, 255, 0.08) 62%, rgba(255, 255, 255, 0) 76%)',
        }}
      />

      {/* Top-Right Soft Ice-Blue & Whisper of Lavender Depth */}
      <div
        className="absolute -top-[16%] -right-[14%] w-[68vw] h-[68vw] max-w-[940px] max-h-[940px] rounded-full animate-ambient-secondary"
        style={{
          background:
            'radial-gradient(circle, rgba(206, 228, 255, 0.42) 0%, rgba(233, 227, 255, 0.22) 40%, rgba(243, 240, 255, 0.07) 64%, rgba(255, 255, 255, 0) 76%)',
        }}
      />

      {/* Center-Left Gentle Horizon Pale-Blue Mist */}
      <div
        className="absolute top-[34%] -left-[16%] w-[64vw] h-[64vw] max-w-[880px] max-h-[880px] rounded-full animate-ambient-lavender"
        style={{
          background:
            'radial-gradient(circle, rgba(203, 226, 255, 0.34) 0%, rgba(232, 241, 255, 0.18) 42%, rgba(255, 255, 255, 0) 74%)',
        }}
      />

      {/* Bottom-Right Balanced Pale-Blue Ambient Anchor */}
      <div
        className="absolute -bottom-[20%] -right-[12%] w-[70vw] h-[70vw] max-w-[960px] max-h-[960px] rounded-full animate-ambient-primary"
        style={{
          background:
            'radial-gradient(circle, rgba(191, 219, 254, 0.38) 0%, rgba(224, 236, 255, 0.2) 42%, rgba(255, 255, 255, 0) 74%)',
        }}
      />

      {/* Subtle Soft-White Luminous Highlight Keeps Text Contrast Effortless */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 68% 58% at 50% 24%, rgba(255, 255, 255, 0.42) 0%, rgba(255, 255, 255, 0.1) 66%, rgba(255, 255, 255, 0) 100%)',
        }}
      />
    </div>
  );
}
