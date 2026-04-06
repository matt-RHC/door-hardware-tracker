'use client';

import React, { useState, useEffect, useRef } from 'react';
import PunchAvatar from './PunchAvatar';
import { usePunchHighlight } from './usePunchHighlight';
import type { PunchAvatarState } from './PunchAvatar';
import type { PunchMessage, PunchQuestion, PunchSeverity } from '@/lib/punch-messages';

// ── Helpers ──────────────────────────────────────────────────────────

const severityColor: Record<PunchSeverity, string> = {
  info:    '#4BA3E3',
  success: '#2ECC71',
  warning: '#E8811A',
  error:   '#E04850',
};

const severityBg: Record<PunchSeverity, string> = {
  info:    'rgba(75,163,227,0.12)',
  success: 'rgba(46,204,113,0.12)',
  warning: 'rgba(232,129,26,0.12)',
  error:   'rgba(224,72,80,0.12)',
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
        animation: 'punchSlideIn 0.3s ease-out both',
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
  // Already answered — show collapsed
  if (question.answer) {
    return (
      <div
        style={{
          padding: '6px 10px',
          borderRadius: 8,
          backgroundColor: 'rgba(46,204,113,0.10)',
          borderLeft: '3px solid #2ECC71',
          fontSize: 12,
          color: '#6B7280',
          animation: 'punchBounce 0.35s ease-out both',
        }}
      >
        <span style={{ color: '#a1a1a6' }}>{question.text}</span>
        <span style={{ marginLeft: 6, color: '#2ECC71', fontWeight: 600 }}>
          → {question.answer}
        </span>
      </div>
    );
  }

  // Dismissed — show muted
  if (question.dismissed) {
    return (
      <div
        style={{
          padding: '6px 10px',
          borderRadius: 8,
          backgroundColor: 'rgba(107,114,128,0.08)',
          borderLeft: '3px solid #6B7280',
          fontSize: 12,
          color: '#6B7280',
          animation: 'punchBounce 0.35s ease-out both',
        }}
      >
        <span>{question.text}</span>
        <span style={{ marginLeft: 6, fontStyle: 'italic' }}>Skipped</span>
      </div>
    );
  }

  // Active question — full card
  return (
    <div
      style={{
        padding: '10px',
        borderRadius: 8,
        backgroundColor: 'rgba(10,132,255,0.10)',
        border: '1px solid rgba(10,132,255,0.25)',
        fontSize: 13,
        color: '#E4E6EB',
        animation: 'punchBounce 0.35s ease-out both',
      }}
    >
      <p style={{ margin: '0 0 8px', lineHeight: '18px' }}>{question.text}</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {question.options.map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onAnswer(question.id, opt)}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid rgba(10,132,255,0.4)',
              backgroundColor: 'rgba(10,132,255,0.15)',
              color: '#4BA3E3',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => {
              (e.target as HTMLButtonElement).style.backgroundColor = 'rgba(10,132,255,0.3)';
            }}
            onMouseLeave={(e) => {
              (e.target as HTMLButtonElement).style.backgroundColor = 'rgba(10,132,255,0.15)';
            }}
          >
            {opt}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onDismiss(question.id)}
          style={{
            padding: '4px 10px',
            borderRadius: 6,
            border: '1px solid rgba(107,114,128,0.3)',
            backgroundColor: 'transparent',
            color: '#6B7280',
            fontSize: 12,
            cursor: 'pointer',
            transition: 'background-color 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.target as HTMLButtonElement).style.backgroundColor = 'rgba(107,114,128,0.15)';
          }}
          onMouseLeave={(e) => {
            (e.target as HTMLButtonElement).style.backgroundColor = 'transparent';
          }}
        >
          Skip
        </button>
      </div>
    </div>
  );
}

// ── Sidebar Panel ────────────────────────────────────────────────────

interface PunchAssistantProps {
  /** Current set of messages to display (non-inline ones show in sidebar). */
  messages: PunchMessage[];
  /** Interactive validation questions. */
  questions?: PunchQuestion[];
  /** Called when user picks an answer. */
  onAnswer?: (questionId: string, answer: string) => void;
  /** Called when user clicks Skip. */
  onDismiss?: (questionId: string) => void;
  /** If true, the sidebar starts collapsed. */
  defaultCollapsed?: boolean;
}

export default function PunchAssistant({
  messages,
  questions = [],
  onAnswer,
  onDismiss,
  defaultCollapsed = false,
}: PunchAssistantProps) {
  const { scrollToRef } = usePunchHighlight();
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const listRef = useRef<HTMLDivElement>(null);

  // Only show non-inline messages in the sidebar
  const sidebarMessages = messages.filter((m) => !m.inline);
  const avatarState = avatarStateFromMessages(sidebarMessages);

  const activeQuestionCount = questions.filter(
    (q) => !q.answer && !q.dismissed,
  ).length;

  // Auto-scroll to bottom when new messages or questions arrive
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [sidebarMessages.length, questions.length]);

  // Badge count for collapsed state (warnings + unanswered questions)
  const warningCount =
    sidebarMessages.filter(
      (m) => m.severity === 'warning' || m.severity === 'error',
    ).length + activeQuestionCount;

  return (
    <>
      {/* Keyframe injection (once) */}
      <style>{`
        @keyframes punchSlideIn {
          from { opacity: 0; transform: translateX(12px); }
          to   { opacity: 1; transform: translateX(0); }
        }
        @keyframes punchBounce {
          0%   { transform: translateX(12px) scale(0.95); opacity: 0; }
          60%  { transform: translateX(-2px) scale(1.02); opacity: 1; }
          100% { transform: translateX(0) scale(1); opacity: 1; }
        }
      `}</style>

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: collapsed ? 48 : 280,
          minHeight: 120,
          maxHeight: '100%',
          borderRadius: 12,
          backgroundColor: '#1c1c1e',
          border: '1px solid #2E323C',
          overflow: 'hidden',
          transition: 'width 0.25s ease',
          flexShrink: 0,
        }}
      >
        {/* Header */}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: collapsed ? '10px 8px' : '10px 12px',
            background: 'none',
            border: 'none',
            borderBottom: collapsed ? 'none' : '1px solid #2E323C',
            cursor: 'pointer',
            color: '#E4E6EB',
            justifyContent: collapsed ? 'center' : 'flex-start',
          }}
        >
          <PunchAvatar size="lg" state={avatarState} />
          {!collapsed && (
            <span style={{ fontWeight: 600, fontSize: 14, whiteSpace: 'nowrap' }}>
              Punch
            </span>
          )}
          {collapsed && warningCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: 6,
                right: 4,
                minWidth: 18,
                height: 18,
                borderRadius: 9,
                backgroundColor: '#E8811A',
                color: '#fff',
                fontSize: 11,
                fontWeight: 700,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 4px',
              }}
            >
              {warningCount}
            </span>
          )}
          {!collapsed && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: 12,
                color: '#6B7280',
              }}
            >
              {collapsed ? '\u25B6' : '\u25C0'}
            </span>
          )}
        </button>

        {/* Message list */}
        {!collapsed && (
          <div
            ref={listRef}
            style={{
              flex: 1,
              overflowY: 'auto',
              padding: '8px 10px',
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            {sidebarMessages.length === 0 && (
              <p style={{ color: '#6B7280', fontSize: 13, margin: 0 }}>
                Waiting for data...
              </p>
            )}

            {sidebarMessages.map((msg, i) => {
              const refKey = msg.field ?? msg.rowId;
              return (
                <div
                  key={`${msg.severity}-${i}`}
                  onClick={refKey ? () => scrollToRef(refKey) : undefined}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 8,
                    backgroundColor: severityBg[msg.severity],
                    borderLeft: `3px solid ${severityColor[msg.severity]}`,
                    fontSize: 13,
                    lineHeight: '18px',
                    color: '#E4E6EB',
                    cursor: refKey ? 'pointer' : undefined,
                    animation: 'punchBounce 0.35s ease-out both',
                    animationDelay: `${i * 60}ms`,
                  }}
                >
                  {msg.text}
                </div>
              );
            })}

            {/* Validation questions */}
            {questions.length > 0 && onAnswer && onDismiss && (
              <>
                {questions.some((q) => !q.answer && !q.dismissed) && (
                  <div
                    style={{
                      padding: '4px 0',
                      borderTop: '1px solid #2E323C',
                      marginTop: 2,
                      fontSize: 11,
                      color: '#6B7280',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    Validation
                  </div>
                )}
                {questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    onAnswer={onAnswer}
                    onDismiss={onDismiss}
                  />
                ))}
              </>
            )}
          </div>
        )}
      </div>
    </>
  );
}
