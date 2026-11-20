import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  apiRequest,
  ApiRequestError,
  loadCachedAnalyses,
  saveCachedAnalyses,
  type ApiErrorInfo,
} from './lib/api';
import { MOTION_DURATION, MOTION_EASE } from './lib/motion';
import type { AnalysisRecord, AppSettings } from './types/forensics';
import { AnalysisWorkspace } from './components/AnalysisWorkspace';
import { DashboardView } from './components/DashboardView';
import { DatasetManagerView } from './components/DatasetManagerView';
import { ForensicReportView } from './components/ForensicReportView';
import { GlobalAmbientCanvas } from './components/GlobalAmbientCanvas';
import { HistoryView } from './components/HistoryView';
import { LandingPage } from './components/LandingPage';
import { SettingsView } from './components/SettingsView';
import { UploadWorkspace } from './components/UploadWorkspace';
import { WorkspaceShell, type WorkspaceTab } from './components/WorkspaceShell';

interface ParsedRoute {
  inWorkspace: boolean;
  tab: WorkspaceTab;
  analysisId: string | null;
}

function parseRouteFromPath(pathname: string): ParsedRoute {
  const clean = pathname.replace(/\/+$/, '') || '/';
  if (clean === '/' || clean === '/home') {
    return { inWorkspace: false, tab: 'overview', analysisId: null };
  }
  const analysisMatch = clean.match(/^\/workspace\/analysis\/([^/]+)$/);
  if (analysisMatch) {
    return {
      inWorkspace: true,
      tab: 'analysis-live',
      analysisId: decodeURIComponent(analysisMatch[1]),
    };
  }
  const reportMatch = clean.match(/^\/workspace\/report\/([^/]+)$/);
  if (reportMatch) {
    return {
      inWorkspace: true,
      tab: 'report-detail',
      analysisId: decodeURIComponent(reportMatch[1]),
    };
  }
  const tabMatch = clean.match(/^\/workspace\/(overview|upload|analyses|history|reports|datasets|settings)$/);
  if (tabMatch) {
    return {
      inWorkspace: true,
      tab: tabMatch[1] as WorkspaceTab,
      analysisId: null,
    };
  }
  if (clean === '/workspace') {
    return { inWorkspace: true, tab: 'overview', analysisId: null };
  }
  return { inWorkspace: false, tab: 'overview', analysisId: null };
}

function buildPathForRoute(
  inWorkspace: boolean,
  tab: WorkspaceTab,
  analysisId: string | null,
): string {
  if (!inWorkspace) return '/';
  if (tab === 'analysis-live' && analysisId) {
    return `/workspace/analysis/${encodeURIComponent(analysisId)}`;
  }
  if (tab === 'report-detail' && analysisId) {
    return `/workspace/report/${encodeURIComponent(analysisId)}`;
  }
  if (tab === 'analysis-live' || tab === 'report-detail') {
    return '/workspace/analyses';
  }
  return `/workspace/${tab}`;
}

function mergeAnalysesLists(
  existing: AnalysisRecord[],
  incoming: AnalysisRecord[],
): AnalysisRecord[] {
  const merged = new Map<string, AnalysisRecord>();
  for (const item of existing) merged.set(item.id, item);
  for (const item of incoming) merged.set(item.id, item);
  return Array.from(merged.values()).sort(
    (a, b) => new Date(b.uploadDate).getTime() - new Date(a.uploadDate).getTime(),
  );
}

export default function App() {
  const initialRoute = parseRouteFromPath(window.location.pathname);

  const [inWorkspace, setInWorkspace] = useState(initialRoute.inWorkspace);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(initialRoute.tab);
  const [analyses, setAnalyses] = useState<AnalysisRecord[]>(() => loadCachedAnalyses());
  const [loadingAnalyses, setLoadingAnalyses] = useState(false);
  const [activeAnalysisId, setActiveAnalysisId] = useState<string | null>(
    initialRoute.tab === 'analysis-live' ? initialRoute.analysisId : null,
  );
  const [selectedReportId, setSelectedReportId] = useState<string | null>(
    initialRoute.tab === 'report-detail' ? initialRoute.analysisId : null,
  );
  const [activeBatchIds, setActiveBatchIds] = useState<string[]>([]);
  const [settings, setSettings] = useState<AppSettings>({
    retainOriginalMediaHours: 24,
    videoFrameSampleCount: 6,
    maxUploadSizeMb: 50,
    storageBackend: 'Local server filesystem JSON persistence (./data)',
    storageNotice: '',
  });
  const [runningSample, setRunningSample] = useState(false);
  const [appError, setAppError] = useState<ApiErrorInfo | null>(null);
  const [showErrorDetails, setShowErrorDetails] = useState(false);
  const prefersReducedMotion = Boolean(useReducedMotion());

  const selectedReport =
    selectedReportId ? analyses.find((a) => a.id === selectedReportId) ?? null : null;

  const pushRoute = useCallback(
    (nextInWorkspace: boolean, nextTab: WorkspaceTab, nextId: string | null = null) => {
      const nextPath = buildPathForRoute(nextInWorkspace, nextTab, nextId);
      if (window.location.pathname !== nextPath) {
        window.history.pushState({ nextInWorkspace, nextTab, nextId }, '', nextPath);
      }
    },
    [],
  );

  // Sync browser Back/Forward navigation cleanly
  useEffect(() => {
    const onPopState = () => {
      const parsed = parseRouteFromPath(window.location.pathname);
      setAppError(null);
      setInWorkspace(parsed.inWorkspace);
      setActiveTab(parsed.tab);
      setActiveAnalysisId(parsed.tab === 'analysis-live' ? parsed.analysisId : null);
      setSelectedReportId(parsed.tab === 'report-detail' ? parsed.analysisId : null);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  // Persist recent analyses in localStorage for refresh & serverless resilience
  useEffect(() => {
    saveCachedAnalyses(analyses);
  }, [analyses]);

  const fetchAnalyses = useCallback(async () => {
    setLoadingAnalyses(true);
    try {
      const { data } = await apiRequest<{ analyses?: AnalysisRecord[] }>('/api/analyses');
      const serverList = data.analyses ?? [];
      setAnalyses((prev) => mergeAnalysesLists(prev, serverList));
    } catch {
      // Keep cached records visible without blocking workspace render
    } finally {
      setLoadingAnalyses(false);
    }
  }, []);

  const fetchSettings = useCallback(async () => {
    try {
      const { data } = await apiRequest<{ settings?: AppSettings }>('/api/settings');
      if (data.settings) setSettings(data.settings);
    } catch {
      // Use defaults
    }
  }, []);

  useEffect(() => {
    if (inWorkspace) {
      void fetchAnalyses();
      void fetchSettings();
    }
  }, [inWorkspace, fetchAnalyses, fetchSettings]);

  // If user refreshes directly on /workspace/report/:id and record isn't cached yet, hydrate it from server.
  // Never show a premature report when an analysis is still processing or awaiting follow-up context.
  useEffect(() => {
    if (activeTab !== 'report-detail' || !selectedReportId) return;
    if (selectedReport) {
      if (selectedReport.status === 'processing' || selectedReport.status === 'needs_context') {
        setActiveAnalysisId(selectedReport.id);
        setSelectedReportId(null);
        setActiveTab('analysis-live');
        pushRoute(true, 'analysis-live', selectedReport.id);
      }
      return;
    }
    let active = true;
    void apiRequest<{ analysis?: AnalysisRecord }>(
      `/api/analyses/${encodeURIComponent(selectedReportId)}`,
    )
      .then(({ data }) => {
        if (!active || !data.analysis) return;
        const rec = data.analysis;
        setAnalyses((prev) => mergeAnalysesLists(prev, [rec]));
        if (rec.status === 'processing' || rec.status === 'needs_context') {
          setActiveAnalysisId(rec.id);
          setSelectedReportId(null);
          setActiveTab('analysis-live');
          pushRoute(true, 'analysis-live', rec.id);
        }
      })
      .catch((err) => {
        if (!active) return;
        if (err instanceof ApiRequestError) {
          setAppError(err);
        }
      });
    return () => {
      active = false;
    };
  }, [activeTab, selectedReportId, selectedReport, pushRoute]);

  const handleEnterWorkspace = (initialTab: 'overview' | 'upload' = 'overview') => {
    setAppError(null);
    setInWorkspace(true);
    setActiveTab(initialTab);
    setActiveAnalysisId(null);
    setSelectedReportId(null);
    pushRoute(true, initialTab);
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleNavigateTab = (tab: WorkspaceTab) => {
    setAppError(null);
    setShowErrorDetails(false);
    setActiveTab(tab);
    if (tab !== 'analysis-live') setActiveAnalysisId(null);
    if (tab !== 'report-detail') setSelectedReportId(null);
    pushRoute(true, tab);
  };

  const handleReturnHome = () => {
    setAppError(null);
    setInWorkspace(false);
    pushRoute(false, 'overview');
    window.scrollTo({ top: 0, behavior: 'auto' });
  };

  const handleAnalysesStarted = (created: AnalysisRecord[]) => {
    setAppError(null);
    setShowErrorDetails(false);
    setSelectedReportId(null);
    setAnalyses((prev) => mergeAnalysesLists(prev, created));
    setActiveBatchIds(created.map((c) => c.id));
    if (created.length > 0) {
      const first = created[0];
      setActiveAnalysisId(first.id);
      setActiveTab('analysis-live');
      pushRoute(true, 'analysis-live', first.id);
    }
  };

  const handleAnalysisUpdated = useCallback((updated: AnalysisRecord) => {
    setAnalyses((prev) => {
      const exists = prev.some((item) => item.id === updated.id);
      if (!exists) return [updated, ...prev];
      return prev.map((item) => (item.id === updated.id ? updated : item));
    });
  }, []);

  const handleOpenAnalysis = (record: AnalysisRecord) => {
    setAppError(null);
    if (record.status === 'completed' || record.status === 'partially_completed') {
      setSelectedReportId(record.id);
      setActiveAnalysisId(null);
      setActiveTab('report-detail');
      pushRoute(true, 'report-detail', record.id);
    } else {
      setActiveAnalysisId(record.id);
      setSelectedReportId(null);
      setActiveTab('analysis-live');
      pushRoute(true, 'analysis-live', record.id);
    }
  };

  const handleRetryAnalysis = async (id: string) => {
    setAppError(null);
    setShowErrorDetails(false);
    try {
      const { data } = await apiRequest<{ analysis?: AnalysisRecord }>(
        `/api/analyses/${encodeURIComponent(id)}/retry`,
        { method: 'POST', timeoutMs: 65_000 },
      );
      if (!data.analysis) {
        setAppError({
          status: 200,
          code: 'MISSING_ANALYSIS',
          endpoint: `/api/analyses/${id}/retry`,
          message: 'Retry request succeeded but did not return an updated analysis.',
          details: `POST /api/analyses/${id}/retry`,
          retryable: true,
        });
        return;
      }
      const updated = data.analysis;
      handleAnalysisUpdated(updated);
      setSelectedReportId(null);
      setActiveAnalysisId(updated.id);
      setActiveTab('analysis-live');
      pushRoute(true, 'analysis-live', updated.id);
    } catch (err) {
      setAppError(
        err instanceof ApiRequestError
          ? err
          : {
              status: 0,
              code: 'RETRY_FAILED',
              endpoint: `/api/analyses/${id}/retry`,
              message: 'Could not connect to TruthLens backend to retry analysis.',
              details: err instanceof Error ? err.message : String(err),
              retryable: true,
            },
      );
    }
  };

  const handleDeleteAnalysis = async (id: string) => {
    try {
      await apiRequest(`/api/analyses/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      // If server already purged record (404), still remove stale cached item cleanly
      if (!(err instanceof ApiRequestError && err.status === 404)) {
        setAppError(
          err instanceof ApiRequestError
            ? err
            : {
                status: 0,
                code: 'DELETE_FAILED',
                endpoint: `/api/analyses/${id}`,
                message: 'Could not delete analysis record.',
                details: err instanceof Error ? err.message : String(err),
                retryable: true,
              },
        );
        return;
      }
    }
    setAnalyses((prev) => prev.filter((item) => item.id !== id));
    setActiveBatchIds((prev) => prev.filter((itemId) => itemId !== id));
    if (selectedReportId === id) {
      setSelectedReportId(null);
      setActiveTab('analyses');
      pushRoute(true, 'analyses');
    }
    if (activeAnalysisId === id) {
      setActiveAnalysisId(null);
      setActiveTab('analyses');
      pushRoute(true, 'analyses');
    }
  };

  const handleRunSample = async (sampleType: 'image' | 'document') => {
    if (runningSample) return;
    setAppError(null);
    setShowErrorDetails(false);
    setRunningSample(true);
    try {
      const { data } = await apiRequest<{ analysis?: AnalysisRecord }>('/api/analyses/sample', {
        method: 'POST',
        body: { sampleType },
        timeoutMs: 65_000,
      });
      if (!data.analysis) {
        setAppError({
          status: 200,
          code: 'SAMPLE_EMPTY',
          endpoint: '/api/analyses/sample',
          message: 'Sample specimen endpoint did not return an analysis record.',
          details: 'POST /api/analyses/sample returned empty payload',
          retryable: true,
        });
        return;
      }
      const created = data.analysis;
      setSelectedReportId(null);
      setAnalyses((prev) => mergeAnalysesLists(prev, [created]));
      setActiveBatchIds([created.id]);
      setActiveAnalysisId(created.id);
      setActiveTab('analysis-live');
      pushRoute(true, 'analysis-live', created.id);
    } catch (err) {
      setAppError(
        err instanceof ApiRequestError
          ? err
          : {
              status: 0,
              code: 'SAMPLE_NETWORK_ERROR',
              endpoint: '/api/analyses/sample',
              message: 'Could not launch sample specimen analysis.',
              details: err instanceof Error ? err.message : String(err),
              retryable: true,
            },
      );
    } finally {
      setRunningSample(false);
    }
  };

  const handleSaveAnalysisToDataset = async (analysis: AnalysisRecord) => {
    const visibleWm = analysis.watermarks.find(
      (w) => w.detected && (w.type === 'visible_text' || w.type === 'visible_logo'),
    );
    await apiRequest('/api/datasets', {
      method: 'POST',
      body: {
        sample_id: `LIVE-${analysis.id}`,
        file_name: analysis.fileName,
        media_type: analysis.mediaType,
        ground_truth_label: 'UNKNOWN',
        generation_platform: visibleWm?.possiblePlatform || 'Unknown',
        visible_watermark: Boolean(visibleWm),
        watermark_text: visibleWm?.recognizedTextOrLogo || '',
        invisible_watermark_status: 'not_verified',
        c2pa_status: analysis.metadata?.c2paStatus || 'absent',
        mime_type: analysis.mimeType,
        file_size_bytes: analysis.fileSizeBytes,
        width: analysis.metadata?.width ?? null,
        height: analysis.metadata?.height ?? null,
        duration_seconds: analysis.metadata?.durationSeconds ?? null,
        frame_rate: analysis.metadata?.frameRate ?? null,
        codec: analysis.metadata?.videoCodec || analysis.metadata?.codec || '',
        encoder: analysis.metadata?.encoder || '',
        exif_software: analysis.metadata?.software || '',
        camera_make: analysis.metadata?.cameraMake || '',
        camera_model: analysis.metadata?.cameraModel || '',
        metadata_present: Boolean(analysis.metadata?.metadataPresent),
        dataset_source: 'Live TruthLens Upload',
        license: 'User-submitted specimen',
        consent_status: 'Pending explicit curation review',
        split: 'live_upload',
        file_hash: analysis.fileHash,
        linked_analysis_id: analysis.id,
        predicted_score: analysis.scoring?.aiLikelihoodScore ?? null,
        predicted_classification: analysis.scoring?.classification ?? '',
        recording_condition:
          analysis.mediaType === 'video'
            ? analysis.videoTelemetry?.cameraCharacteristicsDetected?.length
              ? 'Smartphone / Camera Human Video'
              : analysis.videoTelemetry?.socialMediaReencodeLikely
                ? 'Social Media Re-Encoded Video'
                : ''
            : '',
        notes: `Logged from report ${analysis.id} (Experimental score: ${analysis.scoring?.aiLikelihoodScore ?? 'N/A'}/100 — ${analysis.scoring?.classification ?? 'Pending'}).`,
      },
    });
  };

  const breadcrumbMap: Record<WorkspaceTab, string> = {
    overview: 'Overview',
    upload: 'New analysis',
    analyses: 'My analyses',
    history: 'Detection history',
    reports: 'Reports',
    datasets: 'Datasets',
    settings: 'Settings',
    'analysis-live': `Analysis pipeline · ${activeAnalysisId ?? ''}`,
    'report-detail': `Forensic report · ${selectedReportId ?? ''}`,
  };

  const batchRecords = activeBatchIds
    .map((id) => analyses.find((a) => a.id === id))
    .filter((a): a is AnalysisRecord => Boolean(a));

  return (
    <div className="relative min-h-screen">
      {/* Continuous Pale-Blue & White Mixed Gradient Across Every Page and Section */}
      <GlobalAmbientCanvas />

      {!inWorkspace ? (
        <LandingPage onEnterWorkspace={handleEnterWorkspace} />
      ) : (
        <WorkspaceShell
          activeTab={activeTab}
          breadcrumb={breadcrumbMap[activeTab]}
          onNavigate={handleNavigateTab}
          onReturnHome={handleReturnHome}
        >
          <motion.div
            key={`${activeTab}-${activeAnalysisId ?? ''}-${selectedReportId ?? ''}`}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 5 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: MOTION_DURATION.fast, ease: MOTION_EASE.apple }}
          >
            {appError && (
              <div
                role="alert"
                className="mb-5 bg-[#FEF2F2]/95 border border-[#FECACA] rounded-2xl px-4 py-3.5 text-xs text-[#991B1B] space-y-2"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-[#DC2626]" />
                    <div>
                      <p className="font-semibold">{appError.message}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {appError.retryable && (
                      <button
                        type="button"
                        onClick={() => {
                          setAppError(null);
                          void fetchAnalyses();
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-1 bg-white border border-[#FECACA] rounded-lg font-medium hover:bg-[#FEF2F2] cursor-pointer"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Retry
                      </button>
                    )}
                    {appError.suggestRefresh && (
                      <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="px-2.5 py-1 bg-white/80 border border-[#FECACA] rounded-lg font-medium hover:bg-white cursor-pointer"
                      >
                        Refresh page
                      </button>
                    )}
                  </div>
                </div>
                {appError.details && (
                  <div className="pt-1.5 border-t border-[#FECACA]/70">
                    <button
                      type="button"
                      onClick={() => setShowErrorDetails((v) => !v)}
                      className="inline-flex items-center gap-1 text-[11px] text-[#991B1B]/80 hover:text-[#991B1B] cursor-pointer"
                    >
                      {showErrorDetails ? (
                        <ChevronUp className="w-3 h-3" />
                      ) : (
                        <ChevronDown className="w-3 h-3" />
                      )}
                      Technical details
                    </button>
                    {showErrorDetails && (
                      <p className="mt-1 font-mono text-[11px] bg-white/75 border border-[#FECACA] rounded-lg px-2.5 py-1.5 break-all">
                        {appError.details}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'overview' && (
              <DashboardView
                analyses={analyses}
                loading={loadingAnalyses}
                onStartUpload={() => handleNavigateTab('upload')}
                onOpenAnalysis={handleOpenAnalysis}
                onRunSample={(type) => void handleRunSample(type)}
                runningSample={runningSample}
              />
            )}

            {activeTab === 'upload' && (
              <UploadWorkspace
                maxUploadSizeMb={settings.maxUploadSizeMb}
                onAnalysesStarted={handleAnalysesStarted}
                onRunSample={(type) => void handleRunSample(type)}
                runningSample={runningSample}
              />
            )}

            {activeTab === 'analyses' && (
              <HistoryView
                mode="analyses"
                analyses={analyses}
                loading={loadingAnalyses}
                onOpenAnalysis={handleOpenAnalysis}
                onDeleteAnalysis={handleDeleteAnalysis}
                onStartUpload={() => handleNavigateTab('upload')}
              />
            )}

            {activeTab === 'history' && (
              <HistoryView
                mode="history"
                analyses={analyses}
                loading={loadingAnalyses}
                onOpenAnalysis={handleOpenAnalysis}
                onDeleteAnalysis={handleDeleteAnalysis}
                onStartUpload={() => handleNavigateTab('upload')}
              />
            )}

            {activeTab === 'reports' && (
              <HistoryView
                mode="reports"
                analyses={analyses}
                loading={loadingAnalyses}
                onOpenAnalysis={handleOpenAnalysis}
                onDeleteAnalysis={handleDeleteAnalysis}
                onStartUpload={() => handleNavigateTab('upload')}
              />
            )}

            {activeTab === 'datasets' && <DatasetManagerView />}

            {activeTab === 'settings' && (
              <SettingsView onSettingsChanged={(next) => setSettings(next)} />
            )}

            {activeTab === 'analysis-live' && activeAnalysisId && (
              <AnalysisWorkspace
                analysisId={activeAnalysisId}
                initialRecord={analyses.find((a) => a.id === activeAnalysisId) ?? null}
                batchRecords={batchRecords}
                onSelectAnalysisId={(id) => {
                  setActiveAnalysisId(id);
                  pushRoute(true, 'analysis-live', id);
                }}
                onAnalysisUpdated={handleAnalysisUpdated}
                onViewReport={(rec) => {
                  setSelectedReportId(rec.id);
                  setActiveAnalysisId(null);
                  setActiveTab('report-detail');
                  pushRoute(true, 'report-detail', rec.id);
                }}
                onRetryAnalysis={handleRetryAnalysis}
                onNewUpload={() => {
                  setAppError(null);
                  setSelectedReportId(null);
                  setActiveAnalysisId(null);
                  setActiveBatchIds([]);
                  setActiveTab('upload');
                  pushRoute(true, 'upload');
                }}
              />
            )}

            {activeTab === 'report-detail' && selectedReport && (
              <ForensicReportView
                analysis={selectedReport}
                onBack={() => handleNavigateTab('reports')}
                onNewUpload={() => {
                  setAppError(null);
                  setSelectedReportId(null);
                  setActiveAnalysisId(null);
                  setActiveBatchIds([]);
                  setActiveTab('upload');
                  pushRoute(true, 'upload');
                }}
                onSaveToDataset={handleSaveAnalysisToDataset}
                onRetryAnalysis={handleRetryAnalysis}
                onAnalysisUpdated={handleAnalysisUpdated}
              />
            )}

            {activeTab === 'report-detail' && !selectedReport && (
              <div className="tl-glass-panel rounded-2xl p-8 max-w-xl space-y-3">
                <h2 className="text-base font-semibold text-[#0F172A]">Loading forensic report…</h2>
                <p className="text-xs text-[#52607A]">
                  Retrieving persisted report {selectedReportId}. If this record was deleted or
                  expired, return to your analysis history.
                </p>
                <div className="pt-2">
                  <button
                    type="button"
                    onClick={() => handleNavigateTab('reports')}
                    className="px-3.5 py-2 text-xs font-medium text-[#0F172A] bg-white border border-[#DCE8F8] hover:border-[#A78BFA] rounded-lg cursor-pointer"
                  >
                    Back to Reports
                  </button>
                </div>
              </div>
            )}
          </motion.div>
        </WorkspaceShell>
      )}
    </div>
  );
}
