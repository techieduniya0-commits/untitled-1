import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Info, RefreshCw, Save } from 'lucide-react';
import type { AppSettings, SystemCapabilities } from '../types/forensics';
import { ApiRequestError, apiRequest } from '../lib/api';

interface SettingsViewProps {
  onSettingsChanged: (settings: AppSettings) => void;
}

export function SettingsView({ onSettingsChanged }: SettingsViewProps) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [capabilities, setCapabilities] = useState<SystemCapabilities | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const loadSettings = useCallback(async () => {
    setErrorMessage(null);
    try {
      const { data } = await apiRequest<{
        settings: AppSettings;
        capabilities: SystemCapabilities;
      }>('/api/settings');
      setSettings(data.settings);
      setCapabilities(data.capabilities);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError
          ? err.message
          : 'Failed to load server settings. Please retry.',
      );
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setSaving(true);
    setSavedNotice(false);
    setErrorMessage(null);
    try {
      const { data } = await apiRequest<{ settings: AppSettings }>('/api/settings', {
        method: 'PUT',
        body: {
          retainOriginalMediaHours: settings.retainOriginalMediaHours,
          videoFrameSampleCount: settings.videoFrameSampleCount,
          maxUploadSizeMb: settings.maxUploadSizeMb,
        },
      });
      setSettings(data.settings);
      onSettingsChanged(data.settings);
      setSavedNotice(true);
      setTimeout(() => setSavedNotice(false), 2500);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError
          ? err.message
          : 'Could not save platform settings.',
      );
    } finally {
      setSaving(false);
    }
  };

  if (!settings) {
    if (errorMessage) {
      return (
        <div className="max-w-2xl bg-[#FEF2F2] border border-[#FECACA] rounded-2xl p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-[#991B1B]">
            <AlertCircle className="w-4 h-4 text-[#DC2626] shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
          <button
            type="button"
            onClick={() => void loadSettings()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#991B1B] bg-white hover:bg-[#FEE2E2] border border-[#FECACA] rounded-lg cursor-pointer self-start sm:self-auto"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      );
    }
    return (
      <div className="space-y-4 max-w-3xl">
        <div className="h-44 bg-white/80 border border-[#DCE8F8] rounded-xl animate-pulse" />
        <div className="h-56 bg-white/80 border border-[#DCE8F8] rounded-xl animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-[880px]">
      <div>
        <h1 className="text-2xl font-bold tracking-[-0.02em] text-[#172554]">
          Platform Settings &amp; Runtime Transparency
        </h1>
        <p className="mt-1 text-sm text-[#64748B]">
          Configure media retention, video frame sampling density, and inspect which forensic
          processing libraries are active in this server runtime.
        </p>
      </div>

      {/* Pipeline & Retention Policy Form */}
      <form
        onSubmit={handleSave}
        className="tl-glass-panel rounded-2xl p-6 space-y-5"
      >
        <h2 className="text-base font-semibold text-[#172554]">
          Retention &amp; Forensic Pipeline Controls
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-[#172554]">
              Original Media Retention (hours)
            </span>
            <input
              type="number"
              min={1}
              max={168}
              value={settings.retainOriginalMediaHours}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  retainOriginalMediaHours: Number(e.target.value) || 24,
                })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-[#E5EAF2] rounded-lg text-[#172554]"
            />
            <span className="text-[11px] text-[#64748B] block">
              Uploaded files auto-purge after this window (1–168h).
            </span>
          </label>

          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-[#172554]">
              Video Frame Samples per Clip
            </span>
            <input
              type="number"
              min={4}
              max={10}
              value={settings.videoFrameSampleCount}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  videoFrameSampleCount: Number(e.target.value) || 6,
                })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-[#E5EAF2] rounded-lg text-[#172554]"
            />
            <span className="text-[11px] text-[#64748B] block">
              Evenly sampled keyframes across full video duration (4–10).
            </span>
          </label>

          <label className="space-y-1.5 block">
            <span className="text-xs font-medium text-[#172554]">
              Max Upload File Size (MB)
            </span>
            <input
              type="number"
              min={5}
              max={500}
              value={settings.maxUploadSizeMb}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  maxUploadSizeMb: Number(e.target.value) || 50,
                })
              }
              className="w-full px-3 py-2 text-sm font-mono tabular-nums border border-[#E5EAF2] rounded-lg text-[#172554]"
            />
            <span className="text-[11px] text-[#64748B] block">
              Server-enforced limit (5–500 MB).
            </span>
          </label>
        </div>

        <div className="flex items-center justify-between pt-3 border-t border-[#E5EAF2]">
          <div className="text-xs flex items-center gap-1.5">
            {savedNotice && (
              <span className="text-[#16A34A] inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                Settings saved to persistent server configuration.
              </span>
            )}
            {errorMessage && (
              <span className="text-[#DC2626] inline-flex items-center gap-1.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {errorMessage}
              </span>
            )}
          </div>
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white bg-gradient-to-r from-[#172554] via-[#2563EB] to-[#6D28D9] hover:shadow-[0_10px_24px_-6px_rgba(124,58,237,0.4)] hover:-translate-y-0.5 rounded-xl transition-all duration-200 cursor-pointer disabled:opacity-50"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving…' : 'Save configuration'}
          </button>
        </div>
      </form>

      {/* Storage Transparency */}
      <div className="tl-glass-panel rounded-2xl p-6 space-y-2.5">
        <div className="flex items-center gap-2">
          <Info className="w-4 h-4 text-[#5B21B6]" />
          <h2 className="text-base font-semibold text-[#0F172A]">Storage &amp; Persistence</h2>
        </div>
        <p className="text-xs font-mono text-[#0F172A]">{settings.storageBackend}</p>
        <p className="text-xs leading-relaxed text-[#52607A]">{settings.storageNotice}</p>
      </div>

      {/* Active Forensic Runtime Inventory */}
      {capabilities && (
        <div className="tl-glass-panel rounded-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-[#DCE8F8]/80">
            <h2 className="text-base font-semibold text-[#0F172A]">
              Verified Forensic Runtime Capabilities
            </h2>
            <p className="text-xs text-[#52607A] mt-0.5">
              TruthLens only claims capabilities that are installed and verified on the server.
            </p>
          </div>
          <div className="divide-y divide-[#DCE8F8]/70 text-xs">
            {[
              [
                'FFmpeg / FFprobe (Video & Audio Processing)',
                capabilities.ffmpegAvailable && capabilities.ffprobeAvailable
                  ? 'Active — frame sampling, GOP I/P/B packet probing, PCM decoding, container probing'
                  : 'Unavailable',
                capabilities.ffmpegAvailable && capabilities.ffprobeAvailable,
              ],
              [
                'sharp + exifr (Image Pixel Forensics, ELA & EXIF)',
                capabilities.sharpAvailable
                  ? 'Active — raw RGBA pixel matrix, Laplacian noise, Q90/Q75 double-JPEG delta, watermark crop extraction, EXIF/XMP'
                  : 'Unavailable',
                capabilities.sharpAvailable,
              ],
              [
                'PDF & Document Parsers (unpdf, pdf-lib, mammoth)',
                'Active — PDF text/fonts/XObjects, DOCX extraction, stylometry',
                true,
              ],
              [
                'Gemini Multimodal Forensic Reasoning',
                capabilities.geminiConfigured
                  ? `Active (${capabilities.geminiModel}, server-side configured)`
                  : 'Unavailable — server GEMINI_API_KEY not configured',
                capabilities.geminiConfigured,
              ],
              [
                'C2PA Cryptographic Trust-List Verifier (c2patool)',
                'Unavailable — binary JUMBF/XMP header detection runs, full X.509 chain verification requires native c2patool',
                false,
              ],
              [
                'SynthID Invisible Watermark Verification',
                'Unavailable — proprietary verifier not integrated; reported explicitly as not performed',
                false,
              ],
            ].map(([name, detail, active]) => (
              <div
                key={String(name)}
                className="px-6 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2"
              >
                <div>
                  <p className="font-medium text-[#172554]">{name}</p>
                  <p className="text-[#64748B] mt-0.5">{detail}</p>
                </div>
                <span
                  className={`text-xs font-semibold whitespace-nowrap ${
                    active ? 'text-[#16A34A]' : 'text-[#64748B]'
                  }`}
                >
                  {active ? 'Integrated' : 'Not integrated'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
