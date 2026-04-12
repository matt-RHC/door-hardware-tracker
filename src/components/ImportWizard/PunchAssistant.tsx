'use client';

import React, { useState, useEffect, useRef } from 'react';
import PunchAvatar from './PunchAvatar';
import { usePunchHighlight } from './usePunchHighlight';
import type { PunchAvatarState } from './PunchAvatar';
import type { PunchMessage, PunchQuestion, PunchSeverity } from '@/lib/punch-messages';

// ── Helpers ──────────────────────────────────────────────────────────

const severityColor: Record<PunchSeverity, string> = {
  info:    'var(--blue)',
  success: 'var(--green)',
  warning: 'var(--orange)',
  error:   'var(--red)',
};

const severityBg: Record<PunchSeverity, string> = {
  info:    'var(--blue-dim)',
  success: 'var(--green-dim)',
  warning: 'var(--orange-dim)',
  error:   'var(--red-dim)',
};

function avatarStateFromMessages(msgs: PunchMessage[]): PunchAvatarState {
  if (msgs.some((m) => m.severity === 'error')) return 'error';
  if (msgs.some((m) => m.severity === 'warning')) return 'warning';
  if (msgs.some((m) => m.severity === 'success')) return 'success';
  return 'idle';
}

// ── Inline Tip (badges next to fields / rows) ────────────────────────

interface InlineTipProps {
  message: PunchMessage;
}

export function PunchInlineTip({ message }: InlineTipProps) {
  const color = severityColor[message.severity];
  const bg = severityBg[message.severity];

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 12,
        lineHeight: '18px',
        color,
        backgroundColor: bg,
        border: `1px solid ${color}33`,
      }}
    >
      <PunchAvatar size="sm" state={message.severity === 'info' ? 'idle' : message.severity} />
      {message.text}
    </span>
  );
}

// ── Question Card ────────────────────────────────────────────────────

interface QuestionCardProps {
  question: PunchQuestion;
  onAnswer: (questionId: string, answer: string) => void;
  onDismiss: (questionId: string) => void;
}

function QuestionCard({ question, onAnswer, onDismiss }: QuestionCardProps) {
  if (question.answer) {
    return (
      <div className="py-1.5 px-2.5 rounded-lg bg-success-dim border-l-[3px] border-l-success text-xs text-tertiary">
        <span className="text-secondary">{question.text}</span>
        <span className="ml-1.5 text-success font-semibold">→ {question.answer}</span>
      </div>
    );
  }

  if (question.dismissed) {
    return (
      <div className="py-1.5 px-2.5 rounded-lg bg-tint-strong border-l-[3px] border-l-tertiary text-xs text-tertiary">
        <span>{question.text}</span>
        <span className="ml-1.5 italic">Skipped</span>
      </div>
    );
  }

  return (
    <div className="p-2.5 rounded-lg bg-accent-dim border border-accent text-[13px] text-primary">
      <p className="mb-2 leading-[18px]">{question.text}</p>
      <div className="flex flex-wrap gap-1.5">
        {question.options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onAnswer(question.id, opt)}
            className="px-2.5 py-1 rounded-md border border-accent bg-accent-dim text-accent text-xs font-semibold hover:bg-accent-dim transition-colors"
          >
            {opt}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onDismiss(question.id)}
          className="px-2.5 py-1 rounded-md border border-border-dim-strong text-tertiary text-xs hover:bg-tint-strong transition-colors"
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ── Drawer states ────────────────────────────────────────────────────

type DrawerState = 'collapsed' | 'peek' | 'full';

// ── Bottom Drawer Panel ──────────────────────────────────────────────

interface PunchAssistantProps {
  messages: PunchMessage[];
  questions?: PunchQuestion[];
  onAnswer?: (questionId: string, answer: string) => void;
  onDismiss?: (questionId: string) => void;
  defaultCollapsed?: boolean;
}

export default function PunchAssistant({
  messages,
  questions = [],
  onAnswer,
  onDismiss,
}: PunchAssistantProps) {
  const { scrollToRef } = usePunchHighlight();
  const [drawerState, setDrawerState] = useState<DrawerState>('collapsed');
  const listRef = useRef<HTMLDivElement>(null);

  const sidebarMessages = messages.filter((m) => !m.inline);
  const avatarState = avatarStateFromMessages(sidebarMessages);

  const activeQuestionCount = questions.filter(
    (q) => !q.answer && !q.dismissed,
  ).length;

  const warningCount =
    sidebarMessages.filter(
      (m) => m.severity === 'warning' || m.severity === 'error',
    ).length;
  const totalCount = sidebarMessages.length;

  // Auto-scroll when new messages arrive and drawer is open
  useEffect(() => {
    if (listRef.current && drawerState !== 'collapsed') {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [sidebarMessages.length, questions.length, drawerState]);

  // Auto-open peek when first messages arrive
  useEffect(() => {
    if (totalCount > 0 && drawerState === 'collapsed') {
      setDrawerState('peek');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalCount > 0]);

  const toggleDrawer = () => {
    setDrawerState((s) => {
      if (s === 'collapsed') return 'peek';
      if (s === 'peek') return 'full';
      return 'collapsed';
    });
  };

  // Group messages by severity for full view
  const errorMsgs = sidebarMessages.filter((m) => m.severity === 'error');
  const warningMsgs = sidebarMessages.filter((m) => m.severity === 'warning');
  const infoMsgs = sidebarMessages.filter((m) => m.severity === 'info' || m.severity === 'success');

  return (
    <div
      className={`drawer ${
        drawerState === 'collapsed'
          ? 'drawer--collapsed'
          : drawerState === 'peek'
          ? 'drawer--peek'
          : 'drawer--full'
      }`}
    >
      {/* Pill bar (always visible) — sits at the top since drawer expands down */}
      <div
        onClick={toggleDrawer}
        className="flex items-center gap-3 px-4 pt-3 pb-2 cursor-pointer select-none"
      >
        <PunchAvatar size="sm" state={avatarState} />
        <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
          Punch
        </span>
        {totalCount > 0 && (
          <span className="text-xs px-2.5 py-0.5 rounded-full font-medium" style={{ background: 'var(--blue-dim)', color: 'var(--text-secondary)' }}>
            {totalCount} observation{totalCount !== 1 ? 's' : ''}
          </span>
        )}
        {warningCount > 0 && (
          <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold" style={{ background: 'var(--orange-dim)', color: 'var(--orange)' }}>
            {warningCount} warning{warningCount !== 1 ? 's' : ''}
          </span>
        )}
        {activeQuestionCount > 0 && (
          <span className="text-xs px-2.5 py-0.5 rounded-full font-semibold animate-pulse" style={{ background: 'var(--blue-dim)', color: 'var(--blue)' }}>
            {activeQuestionCount} question{activeQuestionCount !== 1 ? 's' : ''}
          </span>
        )}
        <span className="ml-auto text-xs font-medium" style={{ color: 'var(--blue)' }}>
          {drawerState === 'collapsed' ? 'Expand \u25BE' : drawerState === 'peek' ? 'Full \u25BE' : 'Collapse \u25B4'}
        </span>
      </div>

      {/* Content area (visible in peek/full) */}
      {drawerState !== 'collapsed' && (
        <div
          ref={listRef}
          className="flex-1 overflow-y-auto px-4 pb-4 overscroll-contain"
          style={{ maxHeight: drawerState === 'full' ? 'min(calc(60vh - 80px), 400px)' : '120px' }}
        >
          {sidebarMessages.length === 0 && (
            <p className="text-tertiary text-sm">
              Waiting for extraction results...
            </p>
          )}

          {/* In peek mode: flat list, most recent first */}
          {drawerState === 'peek' && (
            <div className="flex flex-col gap-1.5">
              {sidebarMessages.slice(-5).map((msg, i) => {
                const refKey = msg.field ?? msg.rowId;
                return (
                  <div
                    key={`${msg.severity}-${i}`}
                    onClick={refKey ? () => scrollToRef(refKey) : undefined}
                    className={`py-1.5 px-2.5 rounded-lg text-xs leading-[18px] text-primary ${refKey ? 'cursor-pointer hover:brightness-110' : ''}`}
                    style={{
                      backgroundColor: severityBg[msg.severity],
                      borderLeft: `3px solid ${severityColor[msg.severity]}`,
                    }}
                  >
                    {msg.text}
                  </div>
                );
              })}
              {sidebarMessages.length > 5 && (
                <button
                  onClick={() => setDrawerState('full')}
                  className="text-xs text-accent hover:underline self-start"
                >
                  +{sidebarMessages.length - 5} more...
                </button>
              )}
            </div>
          )}

          {/* In full mode: grouped by severity */}
          {drawerState === 'full' && (
            <div className="flex flex-col gap-3">
              {errorMsgs.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-danger uppercase mb-1.5">Errors ({errorMsgs.length})</h4>
                  <div className="flex flex-col gap-1.5">
                    {errorMsgs.map((msg, i) => {
                      const refKey = msg.field ?? msg.rowId;
                      return (
                        <div
                          key={`error-${i}`}
                          onClick={refKey ? () => scrollToRef(refKey) : undefined}
                          className={`py-1.5 px-2.5 rounded-lg text-xs leading-[18px] text-primary ${refKey ? 'cursor-pointer hover:brightness-110' : ''}`}
                          style={{ backgroundColor: severityBg.error, borderLeft: `3px solid ${severityColor.error}` }}
                        >
                          {msg.text}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {warningMsgs.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-warning uppercase mb-1.5">Warnings ({warningMsgs.length})</h4>
                  <div className="flex flex-col gap-1.5">
                    {warningMsgs.map((msg, i) => {
                      const refKey = msg.field ?? msg.rowId;
                      return (
                        <div
                          key={`warn-${i}`}
                          onClick={refKey ? () => scrollToRef(refKey) : undefined}
                          className={`py-1.5 px-2.5 rounded-lg text-xs leading-[18px] text-primary ${refKey ? 'cursor-pointer hover:brightness-110' : ''}`}
                          style={{ backgroundColor: severityBg.warning, borderLeft: `3px solid ${severityColor.warning}` }}
                        >
                          {msg.text}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {infoMsgs.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-accent uppercase mb-1.5">Info ({infoMsgs.length})</h4>
                  <div className="flex flex-col gap-1.5">
                    {infoMsgs.map((msg, i) => {
                      const refKey = msg.field ?? msg.rowId;
                      return (
                        <div
                          key={`info-${i}`}
                          onClick={refKey ? () => scrollToRef(refKey) : undefined}
                          className={`py-1.5 px-2.5 rounded-lg text-xs leading-[18px] text-primary ${refKey ? 'cursor-pointer hover:brightness-110' : ''}`}
                          style={{ backgroundColor: severityBg.info, borderLeft: `3px solid ${severityColor.info}` }}
                        >
                          {msg.text}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Validation questions */}
              {questions.length > 0 && onAnswer && onDismiss && (
                <div>
                  <h4 className="text-xs font-semibold text-accent uppercase mb-1.5">Questions</h4>
                  <div className="flex flex-col gap-1.5">
                    {questions.map((q) => (
                      <QuestionCard
                        key={q.id}
                        question={q}
                        onAnswer={onAnswer}
                        onDismiss={onDismiss}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Drag handle at the bottom — drawer expands downward */}
      <div
        onClick={toggleDrawer}
        className="cursor-pointer pt-1 pb-2 mt-auto"
      >
        <div className="drawer__handle" />
      </div>
    </div>
  );
}
