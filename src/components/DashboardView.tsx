import { useMemo } from 'react';
import {
  ArrowUpRight,
  AudioWaveform,
  FileSearch,
  FileText,
  Film,
  Image as ImageIcon,
  Upload,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AnalysisRecord } from '../types/forensics';
import {
  classificationTone,
  formatBytes,
  formatDateTime,
  mediaTypeLabel,
} from '../lib/formatters';
import { GlassCard, PremiumButton } from './PremiumUi';

interface DashboardViewProps {
  analyses: AnalysisRecord[];
  loading: boolean;
  onStartUpload: () => void;
  onOpenAnalysis: (analysis: AnalysisRecord) => void;
  onRunSample: (sampleType: 'image' | 'document') => void;
  runningSample: boolean;
}

const MEDIA_COLORS: Record<string, string> = {
  image: '#2563EB',
  video: '#172554',
  pdf: '#0EA5E9',
  document: '#64748B',
  audio: '#16A34A',
};

function MediaIcon({ type }: { type: AnalysisRecord['mediaType'] }) {
  switch (type) {
    case 'image':
      return <ImageIcon className="w-4 h-4 text-[#2563EB]" />;
    case 'video':
      return <Film className="w-4 h-4 text-[#172554]" />;
    case 'audio':
      return <AudioWaveform className="w-4 h-4 text-[#16A34A]" />;
    case 'pdf':
      return <FileSearch className="w-4 h-4 text-[#0284C7]" />;
    default:
      return <FileText className="w-4 h-4 text-[#64748B]" />;
  }
}

export function DashboardView({
  analyses,
  loading,
  onStartUpload,
  onOpenAnalysis,
  onRunSample,
  runningSample,
}: DashboardViewProps) {
  const stats = useMemo(() => {
    const completed = analyses.filter(
      (a) => a.status === 'completed' || a.status === 'partially_completed',
    );
    const elevatedAi = completed.filter(
      (a) =>
        a.scoring?.classification === 'Likely AI-generated' ||
        a.scoring?.classification === 'Potentially AI-assisted' ||
        a.scoring?.classification === 'Potentially manipulated',
    ).length;
    const inconclusive = completed.filter(
      (a) => a.scoring?.classification === 'Inconclusive',
    ).length;
    const likelyHuman = completed.filter(
      (a) => a.scoring?.classification === 'Likely human-created',
    ).length;

    const mediaCounts = [
      { key: 'image', name: 'Images', count: analyses.filter((a) => a.mediaType === 'image').length },
      { key: 'video', name: 'Videos', count: analyses.filter((a) => a.mediaType === 'video').length },
      { key: 'pdf', name: 'PDFs', count: analyses.filter((a) => a.mediaType === 'pdf').length },
      { key: 'document', name: 'Text Docs', count: analyses.filter((a) => a.mediaType === 'document').length },
      { key: 'audio', name: 'Audio', count: analyses.filter((a) => a.mediaType === 'audio').length },
    ];

    // Group last 7 days real activity
    const activityMap = new Map<string, { day: string; total: number; elevated: number }>();
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      const label = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
      activityMap.set(key, { day: label, total: 0, elevated: 0 });
    }

    for (const a of analyses) {
      const dayKey = a.uploadDate.slice(0, 10);
      const bucket = activityMap.get(dayKey);
      if (bucket) {
        bucket.total++;
        if (
          a.scoring?.classification === 'Likely AI-generated' ||
          a.scoring?.classification === 'Potentially AI-assisted' ||
          a.scoring?.classification === 'Potentially manipulated'
        ) {
          bucket.elevated++;
        }
      }
    }

    return {
      total: analyses.length,
      completed: completed.length,
      elevatedAi,
      inconclusive,
      likelyHuman,
      mediaCounts,
      activitySeries: Array.from(activityMap.values()),
    };
  }, [analyses]);

  return (
    <div className="space-y-7">
      {/* Welcome Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-[-0.02em] text-[#172554]">
            Forensic Overview
          </h1>
          <p className="mt-1 text-sm text-[#64748B]">
            Real statistics from your persisted TruthLens analyses. Illustrative dataset seeds are
            kept strictly separate in the Datasets section.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <PremiumButton
            variant="secondary"
            size="md"
            disabled={runningSample}
            onClick={() => onRunSample('image')}
          >
            {runningSample ? 'Starting sample...' : 'Try sample image'}
          </PremiumButton>
          <PremiumButton
            variant="primary"
            size="md"
            onClick={onStartUpload}
          >
            <Upload className="w-3.5 h-3.5" />
            <span>Upload media</span>
          </PremiumButton>
        </div>
      </div>

      {/* 4 KPI Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          {
            label: 'Total analyses',
            value: stats.total,
            sub: `${stats.completed} completed in persistent history`,
            accent: 'text-[#172554]',
          },
          {
            label: 'Elevated AI / manipulation',
            value: stats.elevatedAi,
            sub: 'Likely AI, AI-assisted, or manipulated',
            accent: 'text-[#D97706]',
          },
          {
            label: 'Inconclusive analyses',
            value: stats.inconclusive,
            sub: 'Insufficient or conflicting evidence',
            accent: 'text-[#64748B]',
          },
          {
            label: 'Likely human-created',
            value: stats.likelyHuman,
            sub: 'Low AI-likelihood without conflicts',
            accent: 'text-[#16A34A]',
          },
        ].map((kpi) => (
          <GlassCard key={kpi.label} className="p-5">
            <p className="text-xs font-medium text-[#52607A]">{kpi.label}</p>
            {loading ? (
              <div className="mt-2.5 h-8 w-16 rounded bg-[#EFF6FF] animate-pulse" />
            ) : (
              <p className={`mt-2 text-3xl font-bold font-mono tabular-nums ${kpi.accent}`}>
                {kpi.value}
              </p>
            )}
            <p className="mt-2 text-xs text-[#64748B]">{kpi.sub}</p>
          </GlassCard>
        ))}
      </div>

      {/* Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        <div className="lg:col-span-7 tl-glass-panel rounded-2xl p-6">
          <div className="flex items-center justify-between gap-4 mb-5">
            <div>
              <h2 className="text-base font-semibold text-[#172554]">Detection activity</h2>
              <p className="text-xs text-[#64748B] mt-0.5">
                Live analyses executed over the past 7 days (real records only)
              </p>
            </div>
            <div className="flex items-center gap-4 text-xs text-[#64748B]">
              <span>Blue: All runs</span>
              <span>Amber: Elevated AI</span>
            </div>
          </div>

          <div className="h-[230px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.activitySeries} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5EAF2" vertical={false} />
                <XAxis
                  dataKey="day"
                  tick={{ fill: '#64748B', fontSize: 11 }}
                  axisLine={{ stroke: '#E5EAF2' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#64748B', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={28}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderColor: '#E5EAF2',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: '#172554',
                  }}
                />
                <Bar dataKey="total" name="Total analyses" fill="#2563EB" radius={[4, 4, 0, 0]} maxBarSize={28} />
                <Bar dataKey="elevated" name="Elevated AI/manipulated" fill="#D97706" radius={[4, 4, 0, 0]} maxBarSize={28} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-5 tl-glass-panel rounded-2xl p-6">
          <div className="mb-5">
            <h2 className="text-base font-semibold text-[#172554]">Media-type distribution</h2>
            <p className="text-xs text-[#64748B] mt-0.5">
              Breakdown across verified binary media pipelines
            </p>
          </div>

          <div className="h-[230px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.mediaCounts} layout="vertical" margin={{ left: 8, right: 12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5EAF2" horizontal={false} />
                <XAxis
                  type="number"
                  allowDecimals={false}
                  tick={{ fill: '#64748B', fontSize: 11 }}
                  axisLine={{ stroke: '#E5EAF2' }}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fill: '#172554', fontSize: 12 }}
                  axisLine={false}
                  tickLine={false}
                  width={76}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#FFFFFF',
                    borderColor: '#E5EAF2',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" name="Analyses" radius={[0, 4, 4, 0]} maxBarSize={22}>
                  {stats.mediaCounts.map((entry) => (
                    <Cell key={entry.key} fill={MEDIA_COLORS[entry.key] || '#2563EB'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Recent Activity */}
      <div className="tl-glass-panel rounded-2xl overflow-hidden">
        <div className="px-6 py-4 border-b border-[#DCE8F8]/80 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-[#172554]">Recent forensic activity</h2>
            <p className="text-xs text-[#64748B] mt-0.5">
              Select any completed record to inspect full detector outputs and evidence
            </p>
          </div>
        </div>

        {loading ? (
          <div className="p-6 space-y-3">
            {[1, 2, 3].map((row) => (
              <div key={row} className="h-11 bg-[#F5F7FB] rounded-lg animate-pulse" />
            ))}
          </div>
        ) : analyses.length === 0 ? (
          <div className="p-10 text-center">
            <p className="text-sm font-medium text-[#172554]">No live analyses recorded yet</p>
            <p className="mt-1.5 text-xs text-[#64748B] max-w-md mx-auto">
              TruthLens displays only real completed analyses here rather than fabricated metrics.
              Upload an image, video, audio recording, PDF, or text document — or run a built-in
              sample specimen to test the full forensic pipeline.
            </p>
            <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
              <PremiumButton variant="primary" size="md" onClick={onStartUpload}>
                <Upload className="w-3.5 h-3.5" />
                <span>Upload your first file</span>
              </PremiumButton>
              <PremiumButton
                variant="secondary"
                size="md"
                disabled={runningSample}
                onClick={() => onRunSample('image')}
              >
                Analyse sample architectural photo
              </PremiumButton>
              <PremiumButton
                variant="secondary"
                size="md"
                disabled={runningSample}
                onClick={() => onRunSample('document')}
              >
                Analyse sample text document
              </PremiumButton>
            </div>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#DCE8F8]/80 bg-[#EFF6FF]/45 text-xs font-medium text-[#52607A]">
                  <th className="py-3 px-6">File</th>
                  <th className="py-3 px-4">Type</th>
                  <th className="py-3 px-4 text-right">AI-Likelihood</th>
                  <th className="py-3 px-4">Classification</th>
                  <th className="py-3 px-4">Evidence</th>
                  <th className="py-3 px-4">Date</th>
                  <th className="py-3 px-6 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#DCE8F8]/70 text-sm">
                {analyses.slice(0, 8).map((item) => {
                  const tone = classificationTone(item.scoring?.classification);
                  return (
                    <tr
                      key={item.id}
                      onClick={() => onOpenAnalysis(item)}
                      className="hover:bg-[#EFF6FF]/55 transition-colors cursor-pointer"
                    >
                      <td className="py-3.5 px-6">
                        <div className="flex items-center gap-3 min-w-0">
                          <MediaIcon type={item.mediaType} />
                          <div className="min-w-0">
                            <p className="font-medium text-[#172554] truncate max-w-[260px]">
                              {item.fileName}
                            </p>
                            <p className="text-xs font-mono text-[#64748B] tabular-nums">
                              {item.id} · {formatBytes(item.fileSizeBytes)}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3.5 px-4 text-xs text-[#64748B] whitespace-nowrap">
                        {mediaTypeLabel(item.mediaType)}
                      </td>
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums font-semibold text-[#172554] whitespace-nowrap">
                        {(item.status === 'completed' || item.status === 'partially_completed') &&
                        item.scoring
                          ? `${item.scoring.aiLikelihoodScore}/100`
                          : item.status === 'needs_context'
                            ? 'Pending'
                            : item.status === 'processing'
                              ? 'Running'
                              : 'Failed'}
                      </td>
                      <td
                        className={`py-3.5 px-4 text-xs font-medium whitespace-nowrap ${
                          item.status === 'needs_context' ? 'text-[#6D28D9]' : tone.text
                        }`}
                      >
                        {item.status === 'completed'
                          ? `${item.scoring?.classification ?? 'Inconclusive'}${item.isUpdatedReport ? ' · Updated' : ''}`
                          : item.status === 'partially_completed'
                            ? `${item.scoring?.classification ?? 'Inconclusive'} · Partial`
                            : item.status === 'needs_context'
                              ? 'Follow-up needed'
                              : item.status === 'processing'
                                ? 'Processing pipeline'
                                : 'Analysis failed'}
                      </td>
                      <td className="py-3.5 px-4 text-xs text-[#64748B] whitespace-nowrap">
                        {item.scoring?.evidenceStrength ?? '--'}
                      </td>
                      <td className="py-3.5 px-4 text-xs font-mono tabular-nums text-[#64748B] whitespace-nowrap">
                        {formatDateTime(item.uploadDate)}
                      </td>
                      <td className="py-3.5 px-6 text-right whitespace-nowrap">
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-[#2563EB]">
                          {item.status === 'completed'
                            ? 'View report'
                            : item.status === 'partially_completed'
                              ? 'View partial'
                              : item.status === 'needs_context'
                                ? 'Answer follow-up'
                                : 'Inspect'}
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
