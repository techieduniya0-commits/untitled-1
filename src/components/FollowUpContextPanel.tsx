import { useState } from 'react';
import {
  AlertCircle,
  ArrowRight,
  HelpCircle,
  Info,
  Loader2,
  MessageSquarePlus,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import { apiRequest, ApiRequestError } from '../lib/api';
import type { AnalysisRecord, FollowUpQuestion, UserFollowUpAnswer } from '../types/forensics';
import { PremiumButton } from './PremiumUi';

interface FollowUpContextPanelProps {
  record: AnalysisRecord;
  mode: 'required' | 'optional';
  onReanalysisComplete: (updated: AnalysisRecord) => void;
  onCancel?: () => void;
}

const DEFAULT_OPTIONAL_QUESTIONS: FollowUpQuestion[] = [
  {
    id: 'q_optional_origin',
    category: 'capture_origin',
    question: 'Where did this file originate, and how was it obtained or created?',
    whyAsked:
      'Documenting source origin and transfer history provides helpful context alongside the automated technical findings.',
    suggestedChoices: [
      'Recorded or created directly by me',
      'Downloaded from social media or messaging app',
      'Received from another person or organization',
      'Created or edited using software / AI tools',
      'Unknown source',
    ],
    placeholder: 'Describe where the file came from, device/app used, or any known provenance…',
  },
  {
    id: 'q_optional_editing',
    category: 'editing_history',
    question: 'Was this media edited, compressed, filtered, noise-reduced, or re-exported?',
    whyAsked:
      'Post-processing, noise suppression, or re-encoding can influence signal-level detectors without implying AI generation.',
    suggestedChoices: [
      'Original unedited file',
      'Cropped, compressed, or re-encoded',
      'Enhanced with filters or noise suppression',
      'Partially edited or generated with AI',
      'Unknown editing history',
    ],
    placeholder: 'Note any editing, compression, filters, or tools applied…',
  },
];

export function FollowUpContextPanel({
  record,
  mode,
  onReanalysisComplete,
  onCancel,
}: FollowUpContextPanelProps) {
  const questions =
    record.followUpQuestions && record.followUpQuestions.length > 0
      ? record.followUpQuestions
      : DEFAULT_OPTIONAL_QUESTIONS;

  const hasFailedDetectors =
    record.detectors.some((d) => d.status === 'failed') ||
    record.geminiStatus === 'failed' ||
    record.geminiStatus === 'partially_completed';

  const [answersMap, setAnswersMap] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const prev of record.userContext?.answers ?? []) {
      init[prev.questionId] = prev.answer;
    }
    return init;
  });
  const [userStatement, setUserStatement] = useState(record.userContext?.userStatement ?? '');
  const [rerunDetectors, setRerunDetectors] = useState(hasFailedDetectors);
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const hasAnyInput =
    Object.values(answersMap).some((v) => v.trim().length > 0) || userStatement.trim().length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    if (!hasAnyInput) {
      setErrorMessage(
        'Please answer at least one follow-up question (or select "Unknown") or provide your statement before generating the updated report.',
      );
      return;
    }

    setSubmitting(true);
    setErrorMessage(null);
    try {
      const formattedAnswers: UserFollowUpAnswer[] = questions
        .map((q) => ({
          questionId: q.id,
          question: q.question,
          answer: (answersMap[q.id] ?? '').trim(),
        }))
        .filter((a) => a.answer.length > 0);

      const { data } = await apiRequest<{ analysis?: AnalysisRecord }>(
        `/api/analyses/${encodeURIComponent(record.id)}/followup`,
        {
          method: 'POST',
          timeoutMs: 95_000,
          body: {
            answers: formattedAnswers,
            userStatement: userStatement.trim(),
            rerunAutomatedDetectors: rerunDetectors,
          },
        },
      );

      if (!data.analysis) {
        setErrorMessage('Server did not return the updated forensic report. Please retry.');
        return;
      }

      onReanalysisComplete(data.analysis);
    } catch (err) {
      setErrorMessage(
        err instanceof ApiRequestError
          ? err.message
          : 'Unable to submit follow-up context and reanalyse. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      onSubmit={(e) => void handleSubmit(e)}
      className="tl-glass-panel border-[#C4B5FD]/80 rounded-2xl overflow-hidden shadow-[0_20px_50px_-22px_rgba(79,70,229,0.2)]"
    >
      {/* Header */}
      <div className="px-6 py-5 border-b border-[#DCE8F8] bg-gradient-to-r from-[#EFF6FF]/90 via-white/80 to-[#F3F0FF]/90">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#2563EB] to-[#7C3AED] text-white flex items-center justify-center shrink-0 mt-0.5 shadow-sm">
            {mode === 'required' ? (
              <HelpCircle className="w-4.5 h-4.5" />
            ) : (
              <MessageSquarePlus className="w-4.5 h-4.5" />
            )}
          </div>
          <div className="space-y-1 min-w-0 flex-1">
            <h2 className="text-base font-bold text-[#0F172A]">
              {mode === 'required'
                ? 'Additional Information Needed Before Final Report'
                : 'Provide Additional Context & Generate Updated Report'}
            </h2>
            <p className="text-xs leading-relaxed text-[#475569]">
              {mode === 'required'
                ? 'TruthLens avoids displaying premature or incomplete final reports when essential forensic context is missing or automated signals are uncertain. Answer the targeted questions below so we can reanalyse available evidence and produce a complete, transparent report.'
                : 'Share additional origin details, editing history, or your statement to reanalyse the available evidence and produce a transparent updated report.'}
            </p>
          </div>
        </div>

        {/* Specific reasons why evidence was insufficient */}
        {mode === 'required' &&
          record.insufficiencyReasons &&
          record.insufficiencyReasons.length > 0 && (
            <div className="mt-4 bg-white/85 border border-[#DCE8F8] rounded-xl p-3.5 space-y-1.5">
              <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-[#5B21B6]">
                Why TruthLens is asking follow-up questions
              </p>
              <ul className="space-y-1 text-xs text-[#475569] list-disc pl-4">
                {record.insufficiencyReasons.map((reason, idx) => (
                  <li key={idx}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
      </div>

      {/* Follow-up Questions Body */}
      <div className="p-6 space-y-5">
        {questions.map((q, idx) => {
          const currentVal = answersMap[q.id] ?? '';
          return (
            <div
              key={q.id}
              className="bg-white/75 border border-[#DCE8F8] rounded-xl p-4 space-y-3"
            >
              <div>
                <p className="text-sm font-semibold text-[#0F172A]">
                  <span className="font-mono text-xs text-[#6D28D9] mr-2">
                    Q{idx + 1}.
                  </span>
                  {q.question}
                </p>
                <p className="mt-1 text-xs text-[#64748B]">{q.whyAsked}</p>
              </div>

              {q.suggestedChoices && q.suggestedChoices.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {q.suggestedChoices.map((choice) => {
                    const selected = currentVal === choice;
                    return (
                      <button
                        key={choice}
                        type="button"
                        onClick={() =>
                          setAnswersMap((prev) => ({
                            ...prev,
                            [q.id]: selected ? '' : choice,
                          }))
                        }
                        className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-all cursor-pointer ${
                          selected
                            ? 'bg-gradient-to-r from-[#EFF6FF] to-[#F3F0FF] border-[#7C3AED] text-[#4C1D95] shadow-xs'
                            : 'bg-white border-[#DCE8F8] text-[#475569] hover:border-[#93C5FD] hover:text-[#0F172A]'
                        }`}
                      >
                        {choice}
                      </button>
                    );
                  })}
                </div>
              )}

              <input
                type="text"
                value={currentVal}
                onChange={(e) =>
                  setAnswersMap((prev) => ({ ...prev, [q.id]: e.target.value }))
                }
                placeholder={q.placeholder}
                className="w-full px-3.5 py-2.5 text-xs text-[#0F172A] placeholder:text-[#94A3B8] bg-white border border-[#DCE8F8] focus:border-[#7C3AED] focus:ring-2 focus:ring-[#7C3AED]/15 rounded-lg outline-none transition-all"
              />
            </div>
          );
        })}

        {/* User Statement / Explanation / Opinion */}
        <div className="bg-white/75 border border-[#DCE8F8] rounded-xl p-4 space-y-2">
          <label
            htmlFor={`statement-${record.id}`}
            className="block text-sm font-semibold text-[#0F172A]"
          >
            Your Statement, Explanation, or Opinion (Optional if questions answered above)
          </label>
          <p className="text-xs text-[#64748B]">
            Add any extra context, provenance details, chain-of-custody notes, or your own
            observations. Your statement will be clearly labeled as user-provided context and kept
            separate from objectively detected forensic findings.
          </p>
          <textarea
            id={`statement-${record.id}`}
            rows={3}
            value={userStatement}
            onChange={(e) => setUserStatement(e.target.value)}
            placeholder="Example: This clip was forwarded on WhatsApp by a colleague claiming it was filmed yesterday; I noticed the audio sounded overly smooth…"
            className="w-full px-3.5 py-2.5 text-xs text-[#0F172A] placeholder:text-[#94A3B8] bg-white border border-[#DCE8F8] focus:border-[#7C3AED] focus:ring-2 focus:ring-[#7C3AED]/15 rounded-lg outline-none transition-all resize-y"
          />
        </div>

        {/* Option to re-run automated detectors if original file is still retained */}
        {record.mediaRetained && (
          <label className="flex items-start gap-2.5 text-xs text-[#334155] cursor-pointer select-none">
            <input
              type="checkbox"
              checked={rerunDetectors}
              onChange={(e) => setRerunDetectors(e.target.checked)}
              className="mt-0.5 rounded border-[#CBD5E1] text-[#6D28D9] focus:ring-[#7C3AED] cursor-pointer"
            />
            <span>
              <strong className="text-[#0F172A]">
                Re-run automated forensic detectors on the retained file
              </strong>{' '}
              {hasFailedDetectors
                ? '(Recommended — retries incomplete multimodal detectors to gather missing objective evidence.)'
                : '(Re-verifies automated signals alongside your submitted context.)'}
            </span>
          </label>
        )}

        {/* MANDATORY RE-REPORT TRANSPARENCY NOTICE */}
        <div
          role="note"
          className="bg-gradient-to-r from-[#EFF6FF] via-[#F5F3FF] to-[#EFF6FF] border border-[#C4B5FD] rounded-xl p-4 space-y-1.5"
        >
          <div className="flex items-start gap-2.5">
            <Info className="w-4 h-4 text-[#5B21B6] shrink-0 mt-0.5" />
            <p className="text-xs font-semibold text-[#1E1B4B] leading-relaxed">
              Your updated report will also include your statement and the additional context you
              provided.
            </p>
          </div>
          <div className="flex items-start gap-2.5 pl-6">
            <ShieldAlert className="w-3.5 h-3.5 text-[#475569] shrink-0 mt-0.5" />
            <p className="text-[11px] leading-relaxed text-[#475569]">
              <strong>Evidentiary separation rule:</strong> TruthLens never treats user opinions or
              statements as independently verified evidence. User-provided context is displayed
              separately from objectively detected findings, and confidence scores reflect only the
              actual available technical evidence.
            </p>
          </div>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="bg-[#FEF2F2] border border-[#FECACA] rounded-xl px-4 py-3 text-xs text-[#991B1B] flex items-start gap-2"
          >
            <AlertCircle className="w-4 h-4 text-[#DC2626] shrink-0 mt-0.5" />
            <span>{errorMessage}</span>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          {onCancel ? (
            <button
              type="button"
              onClick={onCancel}
              disabled={submitting}
              className="px-3.5 py-2 text-xs font-medium text-[#52607A] hover:text-[#0F172A] cursor-pointer"
            >
              Cancel
            </button>
          ) : (
            <span className="text-[11px] text-[#64748B]">
              {record.scoring
                ? `Preliminary checks completed: ${record.scoring.methodsPerformedCount} detector(s)`
                : 'Awaiting follow-up input to compile final report'}
            </span>
          )}

          <button
            type="submit"
            disabled={submitting || !hasAnyInput}
            className="hidden"
          />
          <PremiumButton
            variant="primary"
            size="md"
            disabled={submitting || !hasAnyInput}
            onClick={() => {
              const fakeEvent = { preventDefault: () => undefined } as React.FormEvent;
              void handleSubmit(fakeEvent);
            }}
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Reanalysing &amp; Generating Updated Report…</span>
              </>
            ) : (
              <>
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reanalyse &amp; Generate Updated Report</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </>
            )}
          </PremiumButton>
        </div>
      </div>
    </form>
  );
}
