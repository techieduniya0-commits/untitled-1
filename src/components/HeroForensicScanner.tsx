import { useEffect, useRef, useState } from 'react';
import { motion, useSpring, useTransform, type MotionValue } from 'motion/react';
import { MOTION_EASE } from '../lib/motion';

const HERO_SPECIMEN_IMG =
  '/src/assets/images/forensic_specimen_architecture_1795085183127.jpg';

type ScanStageIndex = 0 | 1 | 2 | 3 | 4;

interface ScanStageMeta {
  index: ScanStageIndex;
  shortLabel: string;
  caption: string;
  durationMs: number;
}

const SCAN_STAGES: ScanStageMeta[] = [
  {
    index: 0,
    shortLabel: 'Media Frame',
    caption: 'Digital specimen suspended in calibrated optical glass',
    durationMs: 2400,
  },
  {
    index: 1,
    shortLabel: 'Optical Sweep',
    caption: 'Precision scanning beam indexing spatial pixel boundaries',
    durationMs: 2900,
  },
  {
    index: 2,
    shortLabel: 'Layer Split',
    caption: 'Separating metadata, noise residual, and pixel structure planes',
    durationMs: 3300,
  },
  {
    index: 3,
    shortLabel: 'Inspection Points',
    caption: 'Highlighting illustrative regions for multi-method verification',
    durationMs: 3100,
  },
  {
    index: 4,
    shortLabel: 'Unified Preview',
    caption: 'Reassembling evidence layers into a clean inspection frame',
    durationMs: 2700,
  },
];

interface InspectionPoint {
  id: string;
  x: string;
  y: string;
  label: string;
  align: 'left' | 'right';
  delay: number;
}

const INSPECTION_POINTS: InspectionPoint[] = [
  {
    id: 'pixel',
    x: '24%',
    y: '29%',
    label: 'Pixel Analysis',
    align: 'right',
    delay: 0.08,
  },
  {
    id: 'noise',
    x: '68%',
    y: '34%',
    label: 'Noise Residual',
    align: 'left',
    delay: 0.22,
  },
  {
    id: 'consistency',
    x: '33%',
    y: '66%',
    label: 'Frame Consistency',
    align: 'right',
    delay: 0.36,
  },
  {
    id: 'watermark',
    x: '76%',
    y: '80%',
    label: 'Watermark Scan',
    align: 'left',
    delay: 0.5,
  },
];

/**
 * Calm, airy pale-blue & lavender optical dust field for the light Apple hero backdrop.
 * Automatically pauses when off-screen and disables under prefers-reduced-motion.
 */
export function HeroAmbientParticles({ reducedMotion }: { reducedMotion: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (reducedMotion) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let isVisible = true;
    let width = 0;
    let height = 0;

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      r: number;
      alpha: number;
      phase: number;
      isViolet: boolean;
    }

    const particles: Particle[] = [];

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const targetCount = width < 768 ? 10 : 22;
      if (particles.length !== targetCount) {
        particles.length = 0;
        for (let i = 0; i < targetCount; i++) {
          particles.push({
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - 0.5) * 0.14,
            vy: -0.06 - Math.random() * 0.12,
            r: 1.1 + Math.random() * 1.4,
            alpha: 0.14 + Math.random() * 0.2,
            phase: Math.random() * Math.PI * 2,
            isViolet: i % 3 === 0,
          });
        }
      }
    };

    resize();

    let t = 0;
    let lastDraw = 0;
    const tick = (now: number) => {
      rafId = 0;
      if (!isVisible) return;

      // Throttle to ~30fps — calm ambient dust looks identical while halving CPU/GPU load
      if (now - lastDraw >= 32 && width > 0 && height > 0) {
        lastDraw = now;
        t += 0.018;
        ctx.clearRect(0, 0, width, height);

        const drawLinks = width >= 768;
        const linkDist = 104;
        const linkDistSq = linkDist * linkDist;

        for (let i = 0; i < particles.length; i++) {
          const a = particles[i];
          a.x += a.vx * 1.8;
          a.y += a.vy * 1.8;
          if (a.y < -12) {
            a.y = height + 12;
            a.x = Math.random() * width;
          }
          if (a.x < -12) a.x = width + 12;
          if (a.x > width + 12) a.x = -12;

          if (drawLinks) {
            for (let j = i + 1; j < particles.length; j++) {
              const b = particles[j];
              const dx = a.x - b.x;
              const dy = a.y - b.y;
              const distSq = dx * dx + dy * dy;
              if (distSq < linkDistSq) {
                const dist = Math.sqrt(distSq);
                const lineAlpha = (1 - dist / linkDist) * 0.11;
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x, b.y);
                ctx.strokeStyle = `rgba(96, 165, 250, ${lineAlpha.toFixed(3)})`;
                ctx.lineWidth = 0.7;
                ctx.stroke();
              }
            }
          }

          const pulse = 0.72 + 0.28 * Math.sin(t * 1.2 + a.phase);
          ctx.beginPath();
          ctx.arc(a.x, a.y, a.r, 0, Math.PI * 2);
          ctx.fillStyle = a.isViolet
            ? `rgba(124, 58, 237, ${(a.alpha * pulse).toFixed(3)})`
            : `rgba(59, 130, 246, ${(a.alpha * pulse).toFixed(3)})`;
          ctx.fill();
        }
      }

      if (isVisible) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const startLoop = () => {
      if (rafId === 0 && isVisible) {
        rafId = window.requestAnimationFrame(tick);
      }
    };

    const stopLoop = () => {
      if (rafId !== 0) {
        window.cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };

    const observer = new IntersectionObserver(
      (entries) => {
        isVisible = entries[0]?.isIntersecting ?? true;
        if (isVisible) {
          startLoop();
        } else {
          stopLoop();
        }
      },
      { threshold: 0.02 },
    );
    observer.observe(canvas);
    window.addEventListener('resize', resize, { passive: true });
    startLoop();

    return () => {
      stopLoop();
      window.removeEventListener('resize', resize);
      observer.disconnect();
    };
  }, [reducedMotion]);

  if (reducedMotion) return null;

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full opacity-75"
    />
  );
}

interface HeroForensicScannerProps {
  pointerX: MotionValue<number>;
  pointerY: MotionValue<number>;
  reducedMotion: boolean;
}

export function HeroForensicScanner({
  pointerX,
  pointerY,
  reducedMotion,
}: HeroForensicScannerProps) {
  const [stage, setStage] = useState<ScanStageIndex>(0);
  const [manualLockUntil, setManualLockUntil] = useState<number>(0);
  const [imgError, setImgError] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [inView, setInView] = useState(true);
  const scannerContainerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const el = scannerContainerRef.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        setInView(entries[0]?.isIntersecting ?? true);
      },
      { threshold: 0.05 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (reducedMotion || !inView) return;

    const currentDuration = SCAN_STAGES[stage].durationMs;
    const now = Date.now();
    const extraDelay = manualLockUntil > now ? manualLockUntil - now : 0;

    const timer = window.setTimeout(() => {
      setStage((prev) => ((prev + 1) % SCAN_STAGES.length) as ScanStageIndex);
    }, currentDuration + extraDelay);

    return () => window.clearTimeout(timer);
  }, [stage, manualLockUntil, reducedMotion, inView]);

  const handleSelectStage = (idx: ScanStageIndex) => {
    setStage(idx);
    setManualLockUntil(Date.now() + 4500);
  };

  const smoothX = useSpring(pointerX, { stiffness: 65, damping: 22, mass: 0.9 });
  const smoothY = useSpring(pointerY, { stiffness: 65, damping: 22, mass: 0.9 });

  const tiltMultiplier = reducedMotion ? 0 : isMobile ? 0.25 : 1;
  const parallaxRotateY = useTransform(smoothX, [-1, 1], [-10 * tiltMultiplier, 10 * tiltMultiplier]);
  const parallaxRotateX = useTransform(smoothY, [-1, 1], [7 * tiltMultiplier, -7 * tiltMultiplier]);

  const isSweeping = stage === 1;
  const isExploded = stage === 2;
  const isInspecting = stage === 3;
  const isReassembled = stage === 4;

  const stageBaseRotateY = isMobile
    ? isExploded
      ? -8
      : isInspecting
        ? -3
        : 0
    : isExploded
      ? -20
      : isInspecting
        ? -10
        : isSweeping
          ? -5
          : isReassembled
            ? -3
            : -8;

  const stageBaseRotateX = isMobile
    ? isExploded
      ? 5
      : 2
    : isExploded
      ? 12
      : isInspecting
        ? 7
        : isSweeping
          ? 4
          : isReassembled
            ? 3
            : 6;

  const zScale = isMobile ? 0.45 : 1;
  const backLayerZ = (isExploded ? -52 : isInspecting ? -24 : -6) * zScale;
  const midLayerZ = (isExploded ? 38 : isInspecting ? 18 : 2) * zScale;
  const frontLayerZ = (isExploded ? 76 : isInspecting ? 34 : 4) * zScale;

  return (
    <div ref={scannerContainerRef} className="relative w-full flex flex-col items-center">
      {/* Soft Pale-Blue & Lavender Studio Aura Behind Scanner */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -inset-10 rounded-full"
        style={{
          background:
            'radial-gradient(ellipse 68% 62% at 50% 46%, rgba(191, 219, 254, 0.55) 0%, rgba(237, 233, 254, 0.34) 44%, transparent 74%)',
        }}
      />

      {/* 3D Perspective Stage */}
      <div className="relative w-full max-w-[560px] hero-perspective py-4 sm:py-6">
        <motion.div
          style={{
            rotateX: parallaxRotateX,
            rotateY: parallaxRotateY,
          }}
          className="preserve-3d w-full"
        >
          <div className={reducedMotion ? 'preserve-3d w-full' : 'preserve-3d w-full animate-hero-float'}>
            <motion.div
              animate={{
                rotateY: stageBaseRotateY,
                rotateX: stageBaseRotateX,
              }}
              transition={{ duration: reducedMotion ? 0.2 : 1.05, ease: MOTION_EASE.apple }}
              className="preserve-3d relative w-full aspect-[16/11]"
            >
              {/* LAYER 0 (Back Frosted Glass Plane): Metadata Inspection */}
              <motion.div
                aria-hidden="true"
                animate={{
                  z: backLayerZ,
                  x: isExploded ? (isMobile ? -8 : -20) : isInspecting ? -8 : 0,
                  y: isExploded ? (isMobile ? 8 : 16) : isInspecting ? 5 : 0,
                  opacity: isExploded ? 0.96 : isInspecting ? 0.65 : 0.28,
                }}
                transition={{ duration: reducedMotion ? 0.2 : 0.9, ease: MOTION_EASE.apple }}
                className="pointer-events-none absolute inset-0 rounded-2xl border border-[#BFDBFE] bg-white/82 backdrop-blur-lg shadow-[0_24px_56px_-18px_rgba(37,99,235,0.2)]"
              >
                <div className="absolute inset-0 p-5 flex flex-col justify-between font-mono text-[10px] tracking-[0.08em] text-[#475569]">
                  <div className="flex items-center justify-between border-b border-[#DBEAFE] pb-2.5">
                    <span className="font-semibold text-[#172554]">Metadata Layer</span>
                    <span className="text-[#6D28D9]">EXIF · XMP · C2PA</span>
                  </div>
                  <div className="grid grid-cols-3 gap-3 opacity-80">
                    <div className="space-y-1.5">
                      <div className="h-1 w-14 rounded-full bg-[#93C5FD]" />
                      <div className="h-1 w-20 rounded-full bg-[#DDD6FE]" />
                      <div className="h-1 w-11 rounded-full bg-[#BFDBFE]" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="h-1 w-16 rounded-full bg-[#A78BFA]/70" />
                      <div className="h-1 w-12 rounded-full bg-[#BFDBFE]" />
                      <div className="h-1 w-20 rounded-full bg-[#E2E8F0]" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="h-1 w-12 rounded-full bg-[#93C5FD]" />
                      <div className="h-1 w-16 rounded-full bg-[#DDD6FE]" />
                    </div>
                  </div>
                  <div className="flex items-center justify-between border-t border-[#DBEAFE] pt-2.5 text-[9.5px] text-[#64748B]">
                    <span>Container Schema</span>
                    <span>Plane 01</span>
                  </div>
                </div>
              </motion.div>

              {/* LAYER 1 (Core Physical Media Frame): Specimen Photograph in Apple White Bezel */}
              <div
                className="relative w-full h-full rounded-2xl overflow-hidden border border-white/95 bg-white shadow-[0_28px_64px_-18px_rgba(30,58,138,0.22),0_0_0_1px_rgba(191,219,254,0.85)]"
                style={{ transform: 'translateZ(0px)' }}
              >
                {!imgError ? (
                  <img
                    src={HERO_SPECIMEN_IMG}
                    alt="Architectural glass pavilion digital specimen suspended inside TruthLens forensic inspection frame"
                    loading="eager"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setImgError(true)}
                    className="w-full h-full object-cover select-none"
                  />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[#EFF6FF] via-[#FFFFFF] to-[#F3F0FF] flex items-center justify-center">
                    <span className="text-xs font-mono tracking-wider text-[#475569]">
                      Forensic Specimen Frame
                    </span>
                  </div>
                )}

                {/* Measured contrast scrim strictly at top & bottom edges for legible labels */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    background:
                      'linear-gradient(180deg, rgba(15,23,42,0.44) 0%, rgba(15,23,42,0.02) 28%, rgba(15,23,42,0.02) 72%, rgba(15,23,42,0.52) 100%)',
                  }}
                />

                {/* Precision Corner Framing Brackets */}
                <div aria-hidden="true" className="pointer-events-none absolute inset-3">
                  <span className="absolute top-0 left-0 w-4 h-4 border-t-[1.5px] border-l-[1.5px] border-white/85" />
                  <span className="absolute top-0 right-0 w-4 h-4 border-t-[1.5px] border-r-[1.5px] border-white/85" />
                  <span className="absolute bottom-0 left-0 w-4 h-4 border-b-[1.5px] border-l-[1.5px] border-white/85" />
                  <span className="absolute bottom-0 right-0 w-4 h-4 border-b-[1.5px] border-r-[1.5px] border-white/85" />
                </div>

                {/* Quiet top optical framing label */}
                <div className="pointer-events-none absolute inset-x-4 top-3.5 flex items-center justify-between text-[11px] font-medium text-white/95">
                  <span>Optical Specimen</span>
                  <span className="font-mono text-[10px] text-[#DBEAFE]">
                    {isSweeping
                      ? 'Optical sweep'
                      : isExploded
                        ? 'Layer split'
                        : isInspecting
                          ? 'Region focus'
                          : isReassembled
                            ? 'Unified preview'
                            : 'Ready'}
                  </span>
                </div>

                {/* Stage 2: Smooth Pale-Blue & Soft Electric-Violet Scanning Beam */}
                <motion.div
                  aria-hidden="true"
                  initial={false}
                  animate={
                    isSweeping && !reducedMotion
                      ? {
                          opacity: [0, 1, 1, 0],
                          y: ['-12%', '112%'],
                        }
                      : {
                          opacity: 0,
                          y: '-12%',
                        }
                  }
                  transition={
                    isSweeping && !reducedMotion
                      ? {
                          duration: 2.5,
                          ease: [0.37, 0, 0.63, 1],
                        }
                      : { duration: 0.3 }
                  }
                  className="pointer-events-none absolute inset-x-0 top-0 h-[34%]"
                >
                  <div
                    className="absolute inset-0"
                    style={{
                      background:
                        'linear-gradient(180deg, rgba(147, 197, 253, 0) 0%, rgba(147, 197, 253, 0.22) 66%, rgba(167, 139, 250, 0.42) 96%, rgba(255, 255, 255, 0.92) 100%)',
                    }}
                  />
                  <div className="absolute inset-x-0 bottom-0 h-[2px] bg-gradient-to-r from-transparent via-white to-transparent shadow-[0_0_16px_rgba(124,58,237,0.75)]" />
                </motion.div>

                {/* Stage 5: Clean Glass Specular Sheen */}
                <motion.div
                  aria-hidden="true"
                  initial={false}
                  animate={
                    isReassembled && !reducedMotion
                      ? {
                          x: ['-120%', '140%'],
                          opacity: [0, 0.55, 0],
                        }
                      : { x: '-120%', opacity: 0 }
                  }
                  transition={{ duration: 1.35, ease: MOTION_EASE.apple }}
                  className="pointer-events-none absolute inset-y-0 w-1/2 -skew-x-12"
                  style={{
                    background:
                      'linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.42) 50%, transparent 100%)',
                  }}
                />

                {/* Stage 4: Precision Regional Inspection Reticles */}
                <div className="pointer-events-none absolute inset-0">
                  {INSPECTION_POINTS.map((pt) => {
                    const visible = isInspecting || (isReassembled && pt.id === 'pixel');
                    return (
                      <motion.div
                        key={pt.id}
                        initial={false}
                        animate={{
                          opacity: visible ? 1 : 0,
                          scale: visible ? 1 : 0.78,
                        }}
                        transition={{
                          duration: reducedMotion ? 0.15 : 0.42,
                          delay: visible && !reducedMotion ? pt.delay : 0,
                          ease: MOTION_EASE.apple,
                        }}
                        style={{ left: pt.x, top: pt.y }}
                        className="absolute -translate-x-1/2 -translate-y-1/2"
                      >
                        <div className="relative flex items-center justify-center w-6 h-6">
                          <span className="absolute inset-0 rounded-full border border-white/95 bg-white/15 backdrop-blur-xs shadow-[0_0_14px_rgba(124,58,237,0.45)]" />
                          <span className="w-1.5 h-1.5 rounded-full bg-white" />
                        </div>

                        <div
                          className={`absolute top-1/2 -translate-y-1/2 hidden sm:flex items-center gap-1.5 whitespace-nowrap ${
                            pt.align === 'right' ? 'left-7 flex-row' : 'right-7 flex-row-reverse'
                          }`}
                        >
                          <span className="w-3.5 h-[1px] bg-white/80" />
                          <span className="px-2.5 py-0.5 rounded-md bg-white/92 border border-[#CBDDF8] text-[10.5px] font-medium text-[#172554] shadow-sm backdrop-blur-md">
                            {pt.label}
                          </span>
                        </div>
                      </motion.div>
                    );
                  })}
                </div>

                {/* Bottom subtle specimen footer */}
                <div className="pointer-events-none absolute inset-x-4 bottom-3 flex items-center justify-between text-[10.5px] font-mono tabular-nums text-white/90">
                  <span>Frame consistency</span>
                  <span>0{stage + 1} / 05</span>
                </div>
              </div>

              {/* LAYER 2 (Mid-Front Crystal Plane): Noise Residual */}
              <motion.div
                aria-hidden="true"
                animate={{
                  z: midLayerZ,
                  x: isExploded ? (isMobile ? 6 : 16) : isInspecting ? 6 : 0,
                  y: isExploded ? (isMobile ? -6 : -13) : isInspecting ? -4 : 0,
                  opacity: isExploded ? 0.92 : isInspecting ? 0.44 : isSweeping ? 0.3 : 0,
                }}
                transition={{ duration: reducedMotion ? 0.2 : 0.9, ease: MOTION_EASE.apple }}
                className="pointer-events-none absolute inset-0 rounded-2xl border border-[#93C5FD]/80 bg-white/25 backdrop-blur-[2px] scanner-noise-mesh"
              >
                <div className="absolute top-3.5 right-4 px-2.5 py-0.5 rounded-md bg-white/92 border border-[#CBDDF8] text-[10px] font-medium text-[#172554] shadow-xs">
                  Noise Residual
                </div>
              </motion.div>

              {/* LAYER 3 (Front Optical Glass Plane): Pixel Analysis & Watermark Region */}
              <motion.div
                aria-hidden="true"
                animate={{
                  z: frontLayerZ,
                  x: isExploded ? (isMobile ? 12 : 28) : isInspecting ? 12 : 0,
                  y: isExploded ? (isMobile ? -12 : -24) : isInspecting ? -8 : 0,
                  opacity: isExploded ? 0.96 : isInspecting ? 0.54 : isSweeping ? 0.45 : 0,
                }}
                transition={{ duration: reducedMotion ? 0.2 : 0.9, ease: MOTION_EASE.apple }}
                className="pointer-events-none absolute inset-0 rounded-2xl border border-[#C4B5FD]/85 bg-gradient-to-br from-white/35 via-transparent to-[#EDE9FE]/30 scanner-pixel-grid shadow-[0_20px_48px_-16px_rgba(124,58,237,0.16)]"
              >
                <div className="absolute top-3.5 left-4 px-2.5 py-0.5 rounded-md bg-white/92 border border-[#DDD6FE] text-[10px] font-medium text-[#5B21B6] shadow-xs">
                  Pixel Analysis
                </div>

                <div className="absolute right-3.5 bottom-3.5 w-[38%] h-[22%] rounded-lg border border-dashed border-[#8B5CF6]/70 bg-white/55 backdrop-blur-xs flex items-end justify-end p-2">
                  <span className="text-[9.5px] font-medium text-[#4C1D95]">
                    Watermark Check
                  </span>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </motion.div>

        {/* Soft Studio Floor Shadow */}
        <div
          aria-hidden="true"
          className="pointer-events-none mx-auto mt-6 h-5 w-[72%] rounded-full blur-xl opacity-70"
          style={{
            background:
              'radial-gradient(ellipse at center, rgba(59, 130, 246, 0.22) 0%, rgba(139, 92, 246, 0.14) 48%, transparent 100%)',
          }}
        />
      </div>

      {/* Quiet Interactive 5-Stage Sequence Rail */}
      <div className="mt-2 w-full max-w-[540px] px-1">
        <div
          role="tablist"
          aria-label="Illustrative scanning sequence stages"
          className="grid grid-cols-5 gap-2"
        >
          {SCAN_STAGES.map((item) => {
            const active = stage === item.index;
            return (
              <button
                key={item.shortLabel}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => handleSelectStage(item.index)}
                className="group text-left py-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED] rounded"
              >
                <div className="h-[2.5px] w-full rounded-full bg-[#DBEAFE] overflow-hidden">
                  <motion.div
                    initial={false}
                    animate={{
                      scaleX: active ? 1 : 0,
                      opacity: active ? 1 : 0,
                    }}
                    transition={{
                      duration: active && !reducedMotion ? item.durationMs / 1000 : 0.22,
                      ease: MOTION_EASE.linear,
                    }}
                    style={{ transformOrigin: '0% 50%' }}
                    className="h-full w-full bg-gradient-to-r from-[#2563EB] via-[#6D28D9] to-[#8B5CF6]"
                  />
                </div>
                <span
                  className={`mt-2 block text-[11px] font-medium truncate transition-colors duration-200 ${
                    active ? 'text-[#0F172A]' : 'text-[#64748B] group-hover:text-[#172554]'
                  }`}
                >
                  {item.shortLabel}
                </span>
              </button>
            );
          })}
        </div>

        <div className="mt-1.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1 text-[11.5px] text-[#52607A]">
          <span>{SCAN_STAGES[stage].caption}</span>
          <span className="font-mono text-[10.5px] text-[#64748B] whitespace-nowrap">
            Illustrative preview
          </span>
        </div>
      </div>
    </div>
  );
}
