import { useEffect, useRef, useState, type RefObject } from 'react';

const LENS_SIZE = 140;
const LENS_HALF = LENS_SIZE / 2;
const ZOOM_FACTOR = 1.65;

interface LandingMagnifierProps {
  targetRef: RefObject<HTMLDivElement | null>;
}

/**
 * Real interactive optical magnifying glass — mounted EXCLUSIVELY on the TruthLens Landing Page.
 * Performance-engineered for zero lag across devices:
 * - Disabled automatically on touch/mobile/reduced-motion devices.
 * - Clones the target subtree once on mount + resize and strips heavy GPU effects
 *   (backdrop-filter, blur filters, CSS animations, canvases) inside the clone so the browser
 *   never double-composites frosted glass layers.
 * - Zero getBoundingClientRect() calls inside requestAnimationFrame (uses cached document offsets
 *   + window.scrollY).
 * - On-demand RAF loop: pauses completely when settled or hidden (visibility: hidden), and yields
 *   immediately during section navigation jumps ('tl:nav-jump') for instant, lag-free switching.
 */
export function LandingMagnifier({ targetRef }: LandingMagnifierProps) {
  const [disabled, setDisabled] = useState(true);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const zoomLayerRef = useRef<HTMLDivElement | null>(null);
  const specularRef = useRef<HTMLDivElement | null>(null);
  const cachedOffsetRef = useRef({ left: 0, top: 0 });

  useEffect(() => {
    const mqMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const mqCoarse = window.matchMedia('(pointer: coarse)');
    const mqNoHover = window.matchMedia('(hover: none)');
    const mqSmall = window.matchMedia('(max-width: 767px)');
    const check = () =>
      setDisabled(mqMotion.matches || mqCoarse.matches || mqNoHover.matches || mqSmall.matches);
    check();
    mqMotion.addEventListener('change', check);
    mqCoarse.addEventListener('change', check);
    mqNoHover.addEventListener('change', check);
    mqSmall.addEventListener('change', check);
    return () => {
      mqMotion.removeEventListener('change', check);
      mqCoarse.removeEventListener('change', check);
      mqNoHover.removeEventListener('change', check);
      mqSmall.removeEventListener('change', check);
    };
  }, []);

  // Build and maintain a lightweight, GPU-friendly mirror of the landing page for real 1.65× zoom
  useEffect(() => {
    if (disabled) return;
    const targetEl = targetRef.current;
    const zoomHost = zoomLayerRef.current;
    if (!targetEl || !zoomHost) return;

    const updateCachedOffset = () => {
      const src = targetRef.current;
      if (!src) return;
      const rect = src.getBoundingClientRect();
      cachedOffsetRef.current = {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
      };
    };

    const rebuildClone = () => {
      const src = targetRef.current;
      const host = zoomLayerRef.current;
      if (!src || !host) return;

      const rect = src.getBoundingClientRect();
      if (rect.width <= 0) return;

      cachedOffsetRef.current = {
        left: rect.left + window.scrollX,
        top: rect.top + window.scrollY,
      };

      const clone = src.cloneNode(true) as HTMLElement;
      clone.setAttribute('aria-hidden', 'true');
      clone.style.width = `${rect.width}px`;
      clone.style.minHeight = `${rect.height}px`;
      clone.style.margin = '0';
      clone.style.pointerEvents = 'none';
      clone.style.userSelect = 'none';
      clone.style.contain = 'layout style';

      // Strip IDs, animated canvases, and heavy GPU filters/animations so the clone is ultra-cheap to paint
      clone.querySelectorAll('[id]').forEach((el) => el.removeAttribute('id'));
      clone.querySelectorAll('canvas').forEach((el) => el.remove());

      clone.querySelectorAll('.tl-glass-panel').forEach((el) => {
        const htmlEl = el as HTMLElement;
        htmlEl.style.backdropFilter = 'none';
        htmlEl.style.setProperty('-webkit-backdrop-filter', 'none');
        htmlEl.style.background = 'rgba(255, 255, 255, 0.94)';
      });

      clone
        .querySelectorAll(
          '[class*="backdrop-blur"], [class*="blur-"], .animate-hero-float, .tl-animated-gradient-text',
        )
        .forEach((el) => {
          const htmlEl = el as HTMLElement;
          htmlEl.style.backdropFilter = 'none';
          htmlEl.style.setProperty('-webkit-backdrop-filter', 'none');
          htmlEl.style.animation = 'none';
          if (htmlEl.className && String(htmlEl.className).includes('blur-[')) {
            htmlEl.style.display = 'none';
          }
        });

      clone.querySelectorAll('[data-scroll-reveal="true"]').forEach((el) => {
        const htmlEl = el as HTMLElement;
        htmlEl.style.opacity = '1';
        htmlEl.style.transform = 'none';
      });

      clone.querySelectorAll('h1 span, p, div').forEach((el) => {
        const htmlEl = el as HTMLElement;
        if (htmlEl.style.opacity === '0') {
          htmlEl.style.opacity = '1';
          htmlEl.style.transform = 'none';
        }
      });

      host.replaceChildren(clone);
    };

    rebuildClone();
    const settleTimer = window.setTimeout(rebuildClone, 850);

    let resizeTimer: number | null = null;
    const handleResize = () => {
      updateCachedOffset();
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(rebuildClone, 240);
    };

    window.addEventListener('resize', handleResize, { passive: true });
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => handleResize())
        : null;
    ro?.observe(targetEl);

    return () => {
      window.clearTimeout(settleTimer);
      if (resizeTimer) window.clearTimeout(resizeTimer);
      window.removeEventListener('resize', handleResize);
      ro?.disconnect();
      zoomHost.replaceChildren();
    };
  }, [disabled, targetRef]);

  // On-demand pointer + scroll tracking (zero idle RAF cost, zero layout thrashing)
  useEffect(() => {
    if (disabled) return;

    let rafId = 0;
    let lastTime = performance.now();
    let visible = false;
    let targetOpacity = 0;
    let currentOpacity = 0;
    let suppressUntil = 0;

    let targetX = -300;
    let targetY = -300;
    let currentX = -300;
    let currentY = -300;
    let lastScrollY = window.scrollY;
    let lastScrollX = window.scrollX;

    const scheduleTick = () => {
      if (rafId !== 0) return;
      lastTime = performance.now();
      rafId = window.requestAnimationFrame(tick);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') {
        targetOpacity = 0;
        scheduleTick();
        return;
      }
      targetX = e.clientX;
      targetY = e.clientY;

      if (performance.now() < suppressUntil) {
        targetOpacity = 0;
        scheduleTick();
        return;
      }

      const topBoundary = Math.max(68, cachedOffsetRef.current.top - window.scrollY);
      const insideLandingBody = e.clientY >= topBoundary;

      if (!visible && insideLandingBody) {
        currentX = e.clientX;
        currentY = e.clientY;
        visible = true;
      }
      targetOpacity = insideLandingBody ? 1 : 0;
      scheduleTick();
    };

    const onScroll = () => {
      if (!visible && currentOpacity <= 0.003) return;
      scheduleTick();
    };

    const onNavJump = () => {
      // Yield immediately during section switching so navigation is 100% lag-free
      suppressUntil = performance.now() + 420;
      targetOpacity = 0;
      currentOpacity = 0;
      visible = false;
      if (rootRef.current) {
        rootRef.current.style.opacity = '0';
        rootRef.current.style.visibility = 'hidden';
      }
    };

    const onLeave = () => {
      targetOpacity = 0;
      scheduleTick();
    };

    const tick = (now: number) => {
      rafId = 0;
      const dt = Math.min(0.05, Math.max(0.001, (now - lastTime) / 1000));
      lastTime = now;

      const posFactor = 1 - Math.exp(-28 * dt);
      const opacityFactor = 1 - Math.exp(-16 * dt);

      const prevX = currentX;
      const prevY = currentY;
      currentX += (targetX - currentX) * posFactor;
      currentY += (targetY - currentY) * posFactor;
      currentOpacity += (targetOpacity - currentOpacity) * opacityFactor;

      if (currentOpacity < 0.004 && targetOpacity === 0) {
        currentOpacity = 0;
        visible = false;
      } else if (Math.abs(targetOpacity - currentOpacity) < 0.004) {
        currentOpacity = targetOpacity;
      }

      const root = rootRef.current;
      if (root) {
        if (currentOpacity <= 0.003) {
          root.style.opacity = '0';
          root.style.visibility = 'hidden';
        } else {
          root.style.visibility = 'visible';
          root.style.opacity = currentOpacity.toFixed(3);
          const lx = currentX - LENS_HALF;
          const ly = currentY - LENS_HALF;
          root.style.transform = `translate3d(${lx.toFixed(2)}px, ${ly.toFixed(2)}px, 0)`;
        }
      }

      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const scrolled = scrollX !== lastScrollX || scrollY !== lastScrollY;
      lastScrollX = scrollX;
      lastScrollY = scrollY;

      if (zoomLayerRef.current && currentOpacity > 0.003) {
        const localX = currentX - (cachedOffsetRef.current.left - scrollX);
        const localY = currentY - (cachedOffsetRef.current.top - scrollY);
        const tx = LENS_HALF - localX * ZOOM_FACTOR;
        const ty = LENS_HALF - localY * ZOOM_FACTOR;
        zoomLayerRef.current.style.transform = `translate3d(${tx.toFixed(2)}px, ${ty.toFixed(2)}px, 0) scale(${ZOOM_FACTOR})`;
      }

      if (specularRef.current && currentOpacity > 0.003) {
        const vx = Math.max(-6, Math.min(6, (currentX - prevX) * 0.4));
        const vy = Math.max(-6, Math.min(6, (currentY - prevY) * 0.4));
        specularRef.current.style.transform = `translate3d(${vx.toFixed(2)}px, ${vy.toFixed(2)}px, 0)`;
      }

      // Continue RAF only while lens is still moving, fading, or scrolling
      const posSettled =
        Math.abs(targetX - currentX) < 0.15 && Math.abs(targetY - currentY) < 0.15;
      const opacitySettled = Math.abs(targetOpacity - currentOpacity) < 0.004;

      if (!posSettled || !opacitySettled || (scrolled && currentOpacity > 0.003)) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('tl:nav-jump', onNavJump);
    document.addEventListener('mouseleave', onLeave);
    window.addEventListener('blur', onLeave);

    return () => {
      if (rafId !== 0) window.cancelAnimationFrame(rafId);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('tl:nav-jump', onNavJump);
      document.removeEventListener('mouseleave', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, [disabled]);

  if (disabled) return null;

  return (
    <div
      ref={rootRef}
      aria-hidden="true"
      className="pointer-events-none fixed top-0 left-0 z-[55] opacity-0 will-change-transform select-none"
      style={{
        width: LENS_SIZE,
        height: LENS_SIZE,
        visibility: 'hidden',
        contain: 'layout style',
      }}
    >
      {/* Subtle Pale-Blue & Violet Optical Halo (pure radial gradient, no expensive blur filter) */}
      <div
        className="absolute -inset-4 rounded-full"
        style={{
          background:
            'radial-gradient(circle, rgba(96, 165, 250, 0.2) 48%, rgba(124, 58, 237, 0.12) 68%, transparent 86%)',
        }}
      />

      {/* Refined Angled Optical Loupe Handle */}
      <div
        className="absolute left-[82%] top-[82%] origin-top-left rotate-45"
        style={{ width: 32, height: 9 }}
      >
        <div
          className="w-full h-full rounded-full border border-white/85"
          style={{
            background:
              'linear-gradient(90deg, #60A5FA 0%, #8B5CF6 58%, #4F46E5 100%)',
            boxShadow:
              '0 6px 14px rgba(30, 58, 138, 0.22), inset 0 1px 1px rgba(255, 255, 255, 0.9)',
          }}
        />
      </div>

      {/* Circular Magnifying Glass Aperture Containing Real 1.65× Zoomed Content */}
      <div
        className="relative w-full h-full rounded-full overflow-hidden"
        style={{
          contain: 'strict',
          background:
            'linear-gradient(155deg, #FFFFFF 0%, #F4F9FF 50%, #EAF3FF 100%)',
          boxShadow:
            '0 16px 32px -12px rgba(30, 58, 138, 0.26), 0 6px 14px -4px rgba(124, 58, 237, 0.18), inset 0 1.5px 2px rgba(255, 255, 255, 0.95)',
        }}
      >
        {/* Synchronized Zoomed DOM Layer */}
        <div
          ref={zoomLayerRef}
          className="absolute top-0 left-0 origin-top-left will-change-transform pointer-events-none"
        />

        {/* Subtle Convex Crystal Reflection & Edge Vignette */}
        <div
          ref={specularRef}
          className="absolute -inset-2 rounded-full pointer-events-none will-change-transform"
          style={{
            background:
              'radial-gradient(ellipse 64% 30% at 34% 20%, rgba(255, 255, 255, 0.5) 0%, rgba(255, 255, 255, 0.08) 54%, transparent 78%)',
          }}
        />
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            boxShadow:
              'inset 0 0 14px rgba(37, 99, 235, 0.14), inset 0 1px 2px rgba(255, 255, 255, 0.9)',
          }}
        />

        {/* Minimalist Cardinal Precision Ticks */}
        <span className="absolute top-1.5 left-1/2 -translate-x-1/2 w-[1px] h-2 bg-[#6366F1]/50 pointer-events-none" />
        <span className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-[1px] h-2 bg-[#6366F1]/50 pointer-events-none" />
        <span className="absolute left-1.5 top-1/2 -translate-y-1/2 h-[1px] w-2 bg-[#6366F1]/50 pointer-events-none" />
        <span className="absolute right-1.5 top-1/2 -translate-y-1/2 h-[1px] w-2 bg-[#6366F1]/50 pointer-events-none" />

        {/* Crisp Blue-to-Violet Optical Lens Ring */}
        <div
          className="absolute inset-0 rounded-full pointer-events-none"
          style={{
            border: '2px solid transparent',
            background:
              'linear-gradient(135deg, rgba(59, 130, 246, 0.9), rgba(124, 58, 237, 0.88), rgba(191, 219, 254, 0.95)) border-box',
            WebkitMask:
              'linear-gradient(#fff 0 0) padding-box, linear-gradient(#fff 0 0)',
            WebkitMaskComposite: 'xor',
            maskComposite: 'exclude',
          }}
        />
      </div>
    </div>
  );
}
