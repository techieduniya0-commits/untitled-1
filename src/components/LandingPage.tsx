import { useEffect, useRef, useState, type MouseEvent } from 'react';
import {
  ArrowRight,
  AudioWaveform,
  FileSearch,
  FileText,
  Film,
  Image as ImageIcon,
  Layers,
  Menu,
  Scale,
  ScanEye,
  ShieldCheck,
  X,
} from 'lucide-react';
import { motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'motion/react';
import { MOTION_DURATION, MOTION_EASE } from '../lib/motion';
import { HeroAmbientParticles, HeroForensicScanner } from './HeroForensicScanner';
import { LandingMagnifier } from './LandingMagnifier';
import { GlassCard, PremiumButton, ScrollReveal } from './PremiumUi';
import { TruthLensLogo } from './TruthLensLogo';

interface LandingPageProps {
  onEnterWorkspace: (initialTab?: 'overview' | 'upload') => void;
}

const OPTICS_SPECIMEN_IMG =
  '/src/assets/images/forensic_specimen_optics_1795085234710.jpg';

const NAV_LINKS = [
  { id: 'home', href: '#home', label: 'Home' },
  { id: 'features', href: '#features', label: 'Features' },
  { id: 'how-it-works', href: '#how-it-works', label: 'How It Works' },
  { id: 'about', href: '#about', label: 'About' },
] as const;

type LandingSectionId = (typeof NAV_LINKS)[number]['id'];

export function LandingPage({ onEnterWorkspace }: LandingPageProps) {
  const [opticsImgError, setOpticsImgError] = useState(false);
  const [isScrolled, setIsScrolled] = useState(false);
  const [activeSection, setActiveSection] = useState<LandingSectionId>('home');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const heroSectionRef = useRef<HTMLElement | null>(null);
  const heroRectRef = useRef<{ left: number; top: number; width: number; height: number } | null>(
    null,
  );
  const scrollAnimRafRef = useRef<number>(0);
  const landingContentRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = Boolean(useReducedMotion());

  const pointerX = useMotionValue(0);
  const pointerY = useMotionValue(0);
  const smoothX = useSpring(pointerX, { stiffness: 55, damping: 24, mass: 1 });
  const smoothY = useSpring(pointerY, { stiffness: 55, damping: 24, mass: 1 });

  // Subtle parallax drift for soft hero glow behind heading
  const glowTranslateX = useTransform(smoothX, [-1, 1], [-18, 18]);
  const glowTranslateY = useTransform(smoothY, [-1, 1], [-14, 14]);

  // Fast, interruptible ease-out section switching (~320ms max regardless of scroll distance)
  const scrollToSection = (sectionId: LandingSectionId, e?: MouseEvent<HTMLElement>) => {
    if (e) e.preventDefault();
    setMobileMenuOpen(false);
    setActiveSection(sectionId);

    // Yield magnifier immediately during section transition
    window.dispatchEvent(new CustomEvent('tl:nav-jump'));

    if (scrollAnimRafRef.current) {
      window.cancelAnimationFrame(scrollAnimRafRef.current);
      scrollAnimRafRef.current = 0;
    }

    const targetY =
      sectionId === 'home'
        ? 0
        : (() => {
            const targetEl = document.getElementById(sectionId);
            if (!targetEl) return 0;
            const rect = targetEl.getBoundingClientRect();
            return Math.max(0, Math.round(rect.top + window.scrollY - 68));
          })();

    if (window.location.hash !== `#${sectionId}`) {
      window.history.replaceState(null, '', `#${sectionId}`);
    }

    const startY = window.scrollY;
    const distance = targetY - startY;

    if (prefersReducedMotion || Math.abs(distance) < 16) {
      window.scrollTo(0, targetY);
      return;
    }

    const duration = Math.min(340, Math.max(180, Math.abs(distance) * 0.14));
    const startTime = performance.now();

    const cancelOnUserInput = () => {
      if (scrollAnimRafRef.current) {
        window.cancelAnimationFrame(scrollAnimRafRef.current);
        scrollAnimRafRef.current = 0;
      }
      cleanupListeners();
    };

    const cleanupListeners = () => {
      window.removeEventListener('wheel', cancelOnUserInput);
      window.removeEventListener('touchstart', cancelOnUserInput);
      window.removeEventListener('keydown', cancelOnUserInput);
    };

    window.addEventListener('wheel', cancelOnUserInput, { passive: true });
    window.addEventListener('touchstart', cancelOnUserInput, { passive: true });
    window.addEventListener('keydown', cancelOnUserInput, { passive: true });

    const step = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      // Fast quintic ease-out: snaps crisply toward destination without sluggish tail
      const eased = 1 - Math.pow(1 - t, 3);
      window.scrollTo(0, Math.round(startY + distance * eased));

      if (t < 1) {
        scrollAnimRafRef.current = window.requestAnimationFrame(step);
      } else {
        scrollAnimRafRef.current = 0;
        cleanupListeners();
      }
    };

    scrollAnimRafRef.current = window.requestAnimationFrame(step);
  };

  useEffect(() => {
    return () => {
      if (scrollAnimRafRef.current) {
        window.cancelAnimationFrame(scrollAnimRafRef.current);
      }
    };
  }, []);

  // Passive header elevation check (only flips React state across the 20px threshold)
  useEffect(() => {
    let lastState = window.scrollY > 20;
    setIsScrolled(lastState);
    const handleScroll = () => {
      const next = window.scrollY > 20;
      if (next !== lastState) {
        lastState = next;
        setIsScrolled(next);
      }
    };
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  // Lightweight IntersectionObserver for active nav link highlighting (zero scroll-handler work)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const sectionEls = NAV_LINKS.map((l) => document.getElementById(l.id)).filter(
      (el): el is HTMLElement => Boolean(el),
    );
    if (sectionEls.length === 0) return;

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.target.id) {
            setActiveSection(entry.target.id as LandingSectionId);
          }
        }
      },
      { rootMargin: '-32% 0px -55% 0px', threshold: 0 },
    );

    for (const el of sectionEls) io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileMenuOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileMenuOpen]);

  const handleHeroMouseEnter = (e: MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    heroRectRef.current = { left: r.left, top: r.top, width: r.width, height: r.height };
  };

  const handleHeroMouseMove = (e: MouseEvent<HTMLElement>) => {
    if (prefersReducedMotion) return;
    let rect = heroRectRef.current;
    if (!rect || rect.width === 0 || rect.height === 0) {
      const r = e.currentTarget.getBoundingClientRect();
      rect = { left: r.left, top: r.top, width: r.width, height: r.height };
      heroRectRef.current = rect;
    }
    if (rect.width === 0 || rect.height === 0) return;
    const nx = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ny = ((e.clientY - rect.top) / rect.height) * 2 - 1;
    pointerX.set(nx);
    pointerY.set(ny);
  };

  const handleHeroMouseLeave = () => {
    heroRectRef.current = null;
    pointerX.set(0);
    pointerY.set(0);
  };

  return (
    <div className="relative min-h-screen text-[#0F172A] overflow-x-clip">
      {/* Strict 3-Zone Top Bar Contract — Fast Translucent White Glass Over Continuous Gradient */}
      <header
        className={`fixed top-0 inset-x-0 z-40 border-b backdrop-blur-md transition-[background-color,border-color,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isScrolled
            ? 'bg-white/90 border-[#D4E2F7] shadow-[0_8px_24px_-14px_rgba(30,58,138,0.14)]'
            : 'bg-white/70 border-[#DBE7F8]/70'
        }`}
      >
        <div className="max-w-[1240px] mx-auto px-6 h-16 flex items-center justify-between gap-8">
          <a
            href="#home"
            onClick={(e) => scrollToSection('home', e)}
            className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED] rounded-md"
          >
            <TruthLensLogo variant="light" />
          </a>

          <nav
            aria-label="Primary navigation"
            className="hidden md:flex items-center gap-8 text-[13.5px] font-medium"
          >
            {NAV_LINKS.map((link) => {
              const isActive = activeSection === link.id;
              return (
                <a
                  key={link.href}
                  href={link.href}
                  onClick={(e) => scrollToSection(link.id, e)}
                  className={`relative py-1 whitespace-nowrap shrink-0 transition-colors duration-150 after:absolute after:left-0 after:right-0 after:-bottom-0.5 after:h-[1.5px] after:origin-left after:bg-gradient-to-r after:from-[#3B82F6] after:to-[#7C3AED] after:transition-transform after:duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#7C3AED] rounded-sm ${
                    isActive
                      ? 'text-[#0F172A] font-semibold after:scale-x-100'
                      : 'text-[#475569] hover:text-[#0F172A] after:scale-x-0 hover:after:scale-x-100'
                  }`}
                >
                  {link.label}
                </a>
              );
            })}
          </nav>

          <div className="flex items-center gap-3 shrink-0">
            <PremiumButton
              variant="primary"
              size="md"
              onClick={() => onEnterWorkspace('overview')}
              className="hidden sm:inline-flex"
            >
              Get Started
            </PremiumButton>

            <button
              type="button"
              aria-label={mobileMenuOpen ? 'Close navigation menu' : 'Open navigation menu'}
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
              className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg border border-[#CBDDF8] bg-white/85 text-[#172554] hover:bg-white transition-colors cursor-pointer"
            >
              {mobileMenuOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>

        {/* Responsive Mobile Drawer */}
        {mobileMenuOpen && (
          <div className="md:hidden border-t border-[#DBE7F8] bg-white/95 px-6 py-4 space-y-1">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={(e) => scrollToSection(link.id, e)}
                className={`block py-2.5 text-sm font-medium rounded-lg transition-colors ${
                  activeSection === link.id
                    ? 'text-[#5B21B6] font-semibold'
                    : 'text-[#334155] hover:text-[#0F172A]'
                }`}
              >
                {link.label}
              </a>
            ))}
            <div className="pt-2">
              <PremiumButton
                variant="primary"
                size="md"
                onClick={() => {
                  setMobileMenuOpen(false);
                  onEnterWorkspace('overview');
                }}
                className="w-full"
              >
                Get Started
              </PremiumButton>
            </div>
          </div>
        )}
      </header>

      {/* Real Interactive Optical Magnifying Glass — Strictly Landing Page Only */}
      <LandingMagnifier targetRef={landingContentRef} />

      <div ref={landingContentRef} className="relative z-10">
        <main className="relative">
        {/* Hero Section — Continuous White & Pale-Blue Atmospheric Field */}
        <section
          id="home"
          ref={heroSectionRef}
          onMouseEnter={handleHeroMouseEnter}
          onMouseMove={handleHeroMouseMove}
          onMouseLeave={handleHeroMouseLeave}
          className="tl-section-opt relative overflow-hidden pt-28 pb-20 lg:pt-32 lg:pb-24 min-h-[min(100vh,860px)] flex items-center"
        >
          {/* Subtle Architectural Precision Grid */}
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 hero-tech-grid" />

          {/* Calm Pale-Blue & Subtle Violet Optical Particle Field */}
          <HeroAmbientParticles reducedMotion={prefersReducedMotion} />

          {/* Hero Content Grid */}
          <div className="relative z-10 max-w-[1240px] w-full mx-auto px-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-10 items-center">
              {/* Left Column: Apple-Inspired Typography & Signature CTAs */}
              <div className="relative lg:col-span-6 flex flex-col justify-center">
                {/* Soft Pale-Blue Ambient Glow Behind Heading with Gentle Parallax (pure radial gradient, no blur filter) */}
                <motion.div
                  aria-hidden="true"
                  style={
                    prefersReducedMotion
                      ? undefined
                      : { x: glowTranslateX, y: glowTranslateY }
                  }
                  className="pointer-events-none absolute -top-20 -left-20 w-[520px] h-[360px] rounded-full opacity-85"
                >
                  <div
                    className="w-full h-full rounded-full"
                    style={{
                      background:
                        'radial-gradient(ellipse at center, rgba(147, 197, 253, 0.34) 0%, rgba(196, 181, 253, 0.18) 38%, rgba(238, 246, 255, 0.06) 62%, transparent 76%)',
                    }}
                  />
                </motion.div>

                <motion.p
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: MOTION_DURATION.base, ease: MOTION_EASE.apple }}
                  className="relative text-sm font-medium tracking-[0.04em] text-[#5B21B6] mb-5"
                >
                  Detect. Analyse. Verify.
                </motion.p>

                <h1 className="relative font-[var(--font-display)] text-[clamp(2.65rem,4.9vw,4.35rem)] font-bold leading-[1.06] tracking-[-0.036em] text-[#0F172A]">
                  <motion.span
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: MOTION_DURATION.slow,
                      delay: 0.08,
                      ease: MOTION_EASE.apple,
                    }}
                    className="block"
                  >
                    Know What&apos;s Real.
                  </motion.span>
                  <motion.span
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{
                      duration: MOTION_DURATION.slow,
                      delay: 0.22,
                      ease: MOTION_EASE.apple,
                    }}
                    className="block mt-1.5 tl-animated-gradient-text"
                  >
                    Detect What&apos;s AI.
                  </motion.span>
                </h1>

                <motion.p
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: MOTION_DURATION.base,
                    delay: 0.36,
                    ease: MOTION_EASE.apple,
                  }}
                  className="relative mt-7 text-[16px] sm:text-[17px] leading-[1.68] text-[#475569] max-w-[54ch]"
                >
                  Analyse images, videos, documents and audio using transparent digital-forensics
                  pipelines. Uncover synthetic generation indicators, track visible watermarks and
                  inspect the verifiable evidence behind every assessment.
                </motion.p>

                {/* Signature Hover-Animated Primary & Secondary Buttons */}
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: MOTION_DURATION.base,
                    delay: 0.48,
                    ease: MOTION_EASE.apple,
                  }}
                  className="relative mt-9 flex flex-wrap items-center gap-4"
                >
                  <PremiumButton
                    variant="primary"
                    onClick={() => onEnterWorkspace('upload')}
                  >
                    <span>Start Analysing</span>
                    <ArrowRight className="w-4 h-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1" />
                  </PremiumButton>

                  <PremiumButton
                    variant="secondary"
                    href="#how-it-works"
                    onClick={(e) => scrollToSection('how-it-works', e)}
                  >
                    <span>Explore How It Works</span>
                    <ArrowRight className="w-4 h-4 text-[#6D28D9] transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1" />
                  </PremiumButton>
                </motion.div>

                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{
                    duration: MOTION_DURATION.base,
                    delay: 0.62,
                    ease: MOTION_EASE.apple,
                  }}
                  className="relative mt-11 pt-6 border-t border-[#D7E4F8] flex flex-wrap items-center gap-x-4 gap-y-2 text-xs font-medium text-[#52607A]"
                >
                  <span>Images</span>
                  <span aria-hidden="true" className="text-[#93C5FD]">·</span>
                  <span>Videos</span>
                  <span aria-hidden="true" className="text-[#93C5FD]">·</span>
                  <span>PDFs &amp; Documents</span>
                  <span aria-hidden="true" className="text-[#93C5FD]">·</span>
                  <span>Audio Recordings</span>
                </motion.div>
              </div>

              {/* Right Column: Light Architectural 3D Forensic Scanner */}
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{
                  duration: MOTION_DURATION.slow,
                  delay: 0.2,
                  ease: MOTION_EASE.apple,
                }}
                className="lg:col-span-6 flex items-center justify-center"
              >
                <HeroForensicScanner
                  pointerX={pointerX}
                  pointerY={pointerY}
                  reducedMotion={prefersReducedMotion}
                />
              </motion.div>
            </div>
          </div>

          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#CBDDF8] to-transparent"
          />
        </section>

        {/* Supported Media Types — Seamless Over Global White/Pale-Blue Gradient */}
        <section className="tl-section-opt py-20 border-b border-[#DCE8F8]/80">
          <div className="max-w-[1200px] mx-auto px-6">
            <ScrollReveal>
              <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 mb-10">
                <div>
                  <h2 className="text-2xl md:text-3xl font-bold tracking-[-0.025em] text-[#0F172A]">
                    Media-specific forensic pipelines
                  </h2>
                  <p className="mt-2 text-sm text-[#52607A] max-w-2xl leading-relaxed">
                    Uploaded files are verified by binary magic signature and routed strictly to
                    matching detectors — never running image heuristics on audio or text detectors on
                    video.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onEnterWorkspace('upload')}
                  className="group text-sm font-medium text-[#5B21B6] hover:text-[#4C1D95] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer transition-colors"
                >
                  <span>Upload a file</span>
                  <ArrowRight className="w-4 h-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </button>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              {[
                {
                  icon: ImageIcon,
                  title: 'Images',
                  formats: 'JPG · JPEG · PNG · WEBP',
                  detail:
                    'Pixel entropy, Laplacian noise residual, ELA, lighting/texture review, OCR, visible watermarks, EXIF & C2PA.',
                },
                {
                  icon: Film,
                  title: 'Videos',
                  formats: 'MP4 · MOV · WEBM',
                  detail:
                    'FFmpeg uniform multi-frame sampling, inter-frame deltas, cross-frame watermark tracking, facial & temporal review.',
                },
                {
                  icon: FileSearch,
                  title: 'PDF Documents',
                  formats: 'PDF',
                  detail:
                    'Text layer decoding, font & XObject inventory, container metadata, stylometry, burstiness & linguistic analysis.',
                },
                {
                  icon: FileText,
                  title: 'Text Documents',
                  formats: 'DOCX · TXT',
                  detail:
                    'Sentence-length variance, 4-gram repetition rates, writing-style consistency & passage-level inspection.',
                },
                {
                  icon: AudioWaveform,
                  title: 'Audio Recordings',
                  formats: 'WAV · MP3 · M4A',
                  detail:
                    '16 kHz PCM waveform & DFT spectral centroid, silence ratio, dynamic range, prosody & vocoder artifact review.',
                },
              ].map((item, idx) => {
                const Icon = item.icon;
                return (
                  <ScrollReveal key={item.title} delay={idx * 0.05} className="h-full">
                    <GlassCard className="p-5 h-full flex flex-col justify-between">
                      <div>
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#EFF6FF] to-[#F3F0FF] border border-[#DBEAFE] flex items-center justify-center mb-4">
                          <Icon className="w-[18px] h-[18px] text-[#5B21B6]" />
                        </div>
                        <h3 className="text-base font-semibold text-[#0F172A]">{item.title}</h3>
                        <p className="mt-1 text-xs font-mono text-[#64748B]">{item.formats}</p>
                        <p className="mt-3 text-xs leading-relaxed text-[#475569]">{item.detail}</p>
                      </div>
                    </GlassCard>
                  </ScrollReveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* Detection Capabilities — Asymmetric Bento Over Continuous Canvas */}
        <section id="features" className="tl-section-opt py-22 border-b border-[#DCE8F8]/80">
          <div className="max-w-[1200px] mx-auto px-6">
            <ScrollReveal>
              <div className="max-w-2xl mb-12">
                <h2 className="text-2xl md:text-3xl font-bold tracking-[-0.025em] text-[#0F172A]">
                  Built for inspectable evidence, not black-box scores
                </h2>
                <p className="mt-3 text-[15px] leading-relaxed text-[#52607A]">
                  Every analysis pairs deterministic signal processing with structured multimodal
                  reasoning, then documents each detector&apos;s raw output, reliability tier, and
                  limitations.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <ScrollReveal className="lg:col-span-7 h-full">
                <GlassCard className="p-7 h-full flex flex-col justify-between">
                  <div>
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#EFF6FF] to-[#F3F0FF] border border-[#DBEAFE] flex items-center justify-center mb-4">
                      <ScanEye className="w-5 h-5 text-[#5B21B6]" />
                    </div>
                    <h3 className="text-lg font-semibold text-[#0F172A]">
                      Dedicated Visible Watermark &amp; Cross-Frame Tracking
                    </h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-[#475569]">
                      Standard multimodal passes frequently miss faint generator logos in video
                      corners. TruthLens runs a dedicated watermark pipeline that inspects full
                      frames alongside zoomed 22% margin crops across every sampled video timestamp
                      — identifying visible marks from services like Google Veo, OpenAI Sora,
                      Runway, Kling, and Pika while recording frame position, timestamp, confidence,
                      and persistence.
                    </p>
                  </div>
                  <div className="mt-6 pt-4 border-t border-[#E2ECFA] text-xs text-[#52607A] flex flex-wrap gap-x-4 gap-y-1">
                    <span>Full-frame + edge-strip OCR</span>
                    <span aria-hidden="true" className="text-[#93C5FD]">·</span>
                    <span>Multi-frame persistence tracking</span>
                    <span aria-hidden="true" className="text-[#93C5FD]">·</span>
                    <span>Strict visible vs. invisible separation</span>
                  </div>
                </GlassCard>
              </ScrollReveal>

              <ScrollReveal delay={0.08} className="lg:col-span-5 h-full">
                <GlassCard className="p-7 h-full flex flex-col justify-between">
                  <div>
                    <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#EFF6FF] to-[#F3F0FF] border border-[#DBEAFE] flex items-center justify-center mb-4">
                      <Scale className="w-5 h-5 text-[#2563EB]" />
                    </div>
                    <h3 className="text-lg font-semibold text-[#0F172A]">
                      Reliability-Weighted Evidence Aggregation
                    </h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-[#475569]">
                      Rather than naively averaging detector outputs, the scoring engine groups
                      correlated methods to prevent double-counting, excludes unavailable checks,
                      flags conflicting signals, and reports AI-likelihood separately from Evidence
                      Strength.
                    </p>
                  </div>
                  <div className="mt-6 pt-4 border-t border-[#E2ECFA] text-xs text-[#52607A]">
                    AI-Likelihood (0–100 Experimental) · Evidence Strength (Low / Moderate / Strong)
                  </div>
                </GlassCard>
              </ScrollReveal>

              <ScrollReveal delay={0.06} className="lg:col-span-5 h-full">
                <GlassCard className="p-7 h-full">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#EFF6FF] to-[#F3F0FF] border border-[#DBEAFE] flex items-center justify-center mb-4">
                    <Layers className="w-5 h-5 text-[#2563EB]" />
                  </div>
                  <h3 className="text-lg font-semibold text-[#0F172A]">
                    Full-Duration Video Frame Sampling
                  </h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-[#475569]">
                    Videos are never judged from a single frame. FFmpeg extracts evenly spaced
                    timestamped frames across the entire clip, computes pixel-level inter-frame
                    deltas and scene transitions, and links every finding back to an inspectable
                    frame timeline.
                  </p>
                </GlassCard>
              </ScrollReveal>

              <ScrollReveal delay={0.12} className="lg:col-span-7 h-full">
                <GlassCard className="p-7 h-full">
                  <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#EFF6FF] to-[#F3F0FF] border border-[#DBEAFE] flex items-center justify-center mb-4">
                    <ShieldCheck className="w-5 h-5 text-[#5B21B6]" />
                  </div>
                  <h3 className="text-lg font-semibold text-[#0F172A]">
                    Research-Grade Dataset &amp; Split Governance
                  </h3>
                  <p className="mt-2.5 text-sm leading-relaxed text-[#475569]">
                    Manage labeled evaluation datasets with a 33-column CSV schema separating train,
                    validation, test, and live uploads. Automatically check for duplicate hashes,
                    cross-split source leakage, missing metadata, and consent documentation —
                    without claiming that collecting metadata trains a model.
                  </p>
                </GlassCard>
              </ScrollReveal>
            </div>
          </div>
        </section>

        {/* How It Works — 4-Stage Pipeline */}
        <section id="how-it-works" className="tl-section-opt py-22 border-b border-[#DCE8F8]/80">
          <div className="max-w-[1200px] mx-auto px-6">
            <ScrollReveal>
              <div className="max-w-2xl mb-12">
                <h2 className="text-2xl md:text-3xl font-bold tracking-[-0.025em] text-[#0F172A]">
                  How the forensic pipeline works
                </h2>
                <p className="mt-2 text-sm text-[#52607A] leading-relaxed">
                  Every uploaded file moves through eight observable backend processing stages with
                  no simulated progress bars.
                </p>
              </div>
            </ScrollReveal>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
              {[
                {
                  step: '01. Validate & Hash',
                  desc: 'Verify binary magic bytes, enforce decompression-bomb and size guards, compute SHA-256 fingerprint, and route by true media format.',
                },
                {
                  step: '02. Extract Signals',
                  desc: 'Parse EXIF/XMP/ICC, FFprobe stream codecs, PDF dictionaries, PCM acoustic waveforms, pixel noise residuals, and C2PA container markers.',
                },
                {
                  step: '03. Inspect & Track',
                  desc: 'Run dedicated visible watermark OCR/logo checks alongside multimodal inspection grounded strictly on observed pixels, frames, audio, or text.',
                },
                {
                  step: '04. Aggregate & Report',
                  desc: 'Deduplicate correlated signals, disclose unavailable detectors, separate observed evidence from AI narrative, and export PDF or JSON reports.',
                },
              ].map((item, idx) => (
                <ScrollReveal key={item.step} delay={idx * 0.06} className="h-full">
                  <GlassCard className="p-6 h-full">
                    <h3 className="text-base font-semibold text-[#0F172A]">{item.step}</h3>
                    <p className="mt-2.5 text-sm leading-relaxed text-[#475569]">{item.desc}</p>
                  </GlassCard>
                </ScrollReveal>
              ))}
            </div>
          </div>
        </section>

        {/* Technology Overview & Epistemic Transparency */}
        <section id="about" className="tl-section-opt py-22 border-b border-[#DCE8F8]/80">
          <div className="max-w-[1200px] mx-auto px-6">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-stretch">
              <ScrollReveal className="lg:col-span-5">
                <GlassCard interactive={false} className="h-full min-h-[300px] p-2">
                  <div className="w-full h-full rounded-xl overflow-hidden bg-[#EFF6FF]">
                    {!opticsImgError ? (
                      <img
                        src={OPTICS_SPECIMEN_IMG}
                        alt="Optical calibration lenses and laboratory reference cards"
                        referrerPolicy="no-referrer"
                        onError={() => setOpticsImgError(true)}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-sm text-[#52607A]">
                        Optical calibration reference
                      </div>
                    )}
                  </div>
                </GlassCard>
              </ScrollReveal>

              <ScrollReveal delay={0.1} className="lg:col-span-7 flex flex-col justify-center">
                <h2 className="text-2xl md:text-3xl font-bold tracking-[-0.025em] text-[#0F172A]">
                  Epistemic transparency by design
                </h2>
                <p className="mt-4 text-[15px] leading-relaxed text-[#475569]">
                  No multimedia detector can guarantee 100% accuracy. Compression, cropping, camera
                  denoising, and fast-evolving generative models create real uncertainty. TruthLens
                  is engineered to make that uncertainty explicit rather than hiding it behind a
                  single overconfident percentage.
                </p>

                <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-5 pt-6 border-t border-[#DCE8F8]">
                  <div>
                    <h3 className="text-sm font-semibold text-[#0F172A]">
                      Estimates, never definitive proof
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#52607A]">
                      Uncalibrated composite scores are explicitly labeled Experimental
                      AI-Likelihood Estimates, distinguishing likely AI-generated, AI-assisted,
                      manipulated, inconclusive, and likely human-created results.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-[#0F172A]">
                      Honest reporting of unavailable tools
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#52607A]">
                      When a specialized detector (such as SynthID invisible watermark verification,
                      dense optical flow, or ASVspoof voice biometrics) is not integrated,
                      TruthLens explicitly marks it as not performed.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-[#0F172A]">
                      Metadata is contextual, not conclusive
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#52607A]">
                      Missing EXIF data or software tags never trigger automatic AI classifications,
                      as messaging apps and editors routinely strip or alter container headers.
                    </p>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-[#0F172A]">
                      Controlled media retention
                    </h3>
                    <p className="mt-1.5 text-xs leading-relaxed text-[#52607A]">
                      Uploaded files are validated without execution, linked by SHA-256 hash, and
                      purged automatically after the retention window or immediately upon deletion.
                    </p>
                  </div>
                </div>

                <div className="mt-8">
                  <PremiumButton
                    variant="primary"
                    onClick={() => onEnterWorkspace('upload')}
                  >
                    <span>Open Forensic Workspace</span>
                    <ArrowRight className="w-4 h-4 transition-transform duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-1" />
                  </PremiumButton>
                </div>
              </ScrollReveal>
            </div>
          </div>
        </section>
      </main>

      {/* Quiet Continuous Footer */}
      <footer className="relative z-10 py-10 bg-white/45 backdrop-blur-md">
        <div className="max-w-[1200px] mx-auto px-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <TruthLensLogo variant="light" />
            <span className="text-xs text-[#52607A]">Detect. Analyse. Verify.</span>
          </div>
          <div className="flex flex-wrap items-center gap-6 text-xs text-[#52607A]">
            <button
              type="button"
              onClick={() => onEnterWorkspace('overview')}
              className="hover:text-[#0F172A] transition-colors cursor-pointer"
            >
              Dashboard
            </button>
            <button
              type="button"
              onClick={() => onEnterWorkspace('upload')}
              className="hover:text-[#0F172A] transition-colors cursor-pointer"
            >
              New analysis
            </button>
            <span>Detection scores are estimates, not definitive proof of authorship.</span>
          </div>
        </div>
      </footer>
      </div>
    </div>
  );
}
