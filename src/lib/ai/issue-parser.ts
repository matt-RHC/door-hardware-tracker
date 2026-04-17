import Anthropic from '@anthropic-ai/sdk'
import type { IssueType, IssueSeverity } from '@/lib/types/database'

const SYSTEM_PROMPT = `You are a construction project assistant that extracts structured issue reports from field communications about door hardware.

DOMAIN KNOWLEDGE:
- Door numbers appear as "door 208", "rm 208", "208", "#208", "D-208"
- Finish codes: US26D (satin chrome), US32D (stainless), 652 (prime coat), PVD, etc.
- Keying terms: KA (keyed alike), KD (keyed different), master key, rekeyed, IC core
- Hardware types: hinges, locksets, exit devices, closers, flush bolts, coordinators, kick plates, thresholds, etc.
- Common issues: wrong SKU delivered, damaged in shipping, keying doesn't match schedule, finish mismatch, missing items from delivery

EXTRACTION RULES:
- Extract EACH distinct issue as a separate object (one email may contain multiple issues)
- For opening_identifier: extract the door number/name exactly as written
- For item_name: map to the closest hardware category
- For severity: critical = life safety/fire rating/ADA; high = blocks installation; medium = needs resolution before closeout; low = cosmetic/minor
- For assignee_hint: infer from context (e.g., "supplier needs to replace" → supplier, "foreman should check" → foreman)
- Set confidence 0.0-1.0 based on how clear the input is
- Use null for any field you cannot confidently infer — NEVER invent data
- Include parse_notes explaining your reasoning for each extracted field`

export interface ParsedIssue {
  issue_title: string
  issue_type: IssueType
  severity: IssueSeverity
  opening_identifier: string | null
  item_name: string | null
  description: string
  evidence: string[]
  requested_action: 'approval' | 'replacement' | 'escalation' | 'inspection' | null
  assignee_hint: 'foreman' | 'consultant' | 'locksmith' | 'gc' | 'supplier' | null
  confidence: number
  parse_notes: string
}

export interface ParseEmailResult {
  issues: ParsedIssue[]
  token_usage: {
    input_tokens: number
    output_tokens: number
  }
}

const ISSUE_TOOL: Anthropic.Messages.Tool = {
  name: 'extract_issues',
  description: 'Extract structured issue reports from field communications about door hardware.',
  input_schema: {
    type: 'object' as const,
    properties: {
      issues: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            issue_title: { type: 'string', description: 'Actionable title, max 120 chars' },
            issue_type: {
              type: 'string',
              enum: [
                'wrong_sku', 'damaged', 'keying_mismatch', 'finish_variation',
                'missing_items', 'substitution_needed', 'install_defect',
                'photo_mismatch', 'compliance_risk', 'other',
              ],
            },
            severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
            opening_identifier: { type: ['string', 'null'], description: 'Door number as written' },
            item_name: { type: ['string', 'null'], description: 'Hardware category' },
            description: { type: 'string', description: 'Full details, max 500 chars' },
            evidence: {
              type: 'array',
              items: {
                type: 'string',
                enum: ['photo', 'measurement', 'email_chain', 'sample', 'spec_comparison'],
              },
            },
            requested_action: {
              type: ['string', 'null'],
              enum: ['approval', 'replacement', 'escalation', 'inspection', null],
            },
            assignee_hint: {
              type: ['string', 'null'],
              enum: ['foreman', 'consultant', 'locksmith', 'gc', 'supplier', null],
            },
            confidence: { type: 'number', description: '0-1 confidence score' },
            parse_notes: { type: 'string', description: 'Explanation of inferences' },
          },
          required: [
            'issue_title', 'issue_type', 'severity', 'opening_identifier',
            'item_name', 'description', 'evidence', 'requested_action',
            'assignee_hint', 'confidence', 'parse_notes',
          ],
        },
      },
    },
    required: ['issues'],
  },
}

export async function parseEmail(emailBody: string, emailFrom?: string, emailSubject?: string): Promise<ParseEmailResult> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 3,
    timeout: 60_000,
  })

  const userContent = [
    emailSubject ? `Subject: ${emailSubject}` : '',
    emailFrom ? `From: ${emailFrom}` : '',
    '',
    emailBody,
  ].filter(Boolean).join('\n')

  const response = await client.messages.create({
    model: 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [ISSUE_TOOL],
    tool_choice: { type: 'tool', name: 'extract_issues' },
    messages: [
      {
        role: 'user',
        content: `Parse the following email and extract all door hardware issues:\n\n${userContent}`,
      },
    ],
  })

  const tokenUsage = {
    input_tokens: response.usage.input_tokens,
    output_tokens: response.usage.output_tokens,
  }

  // Extract tool use result
  const toolBlock = response.content.find(
    (block): block is Anthropic.Messages.ToolUseBlock => block.type === 'tool_use'
  )

  if (!toolBlock) {
    console.error('[issue-parser] No tool_use block in response')
    return { issues: [], token_usage: tokenUsage }
  }

  const parsed = toolBlock.input as { issues: ParsedIssue[] }

  return {
    issues: parsed.issues ?? [],
    token_usage: tokenUsage,
  }
}

export async function summarizeTranscript(transcript: string): Promise<string | null> {
  try {
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      maxRetries: 2,
      timeout: 30_000,
    })

    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Summarize this voice memo transcript about a door hardware issue into 2-3 concise bullet points. Focus on the issue described, the door/hardware involved, and any requested action.\n\nTranscript:\n${transcript}`,
        },
      ],
    })

    const textBlock = response.content.find(
      (block): block is Anthropic.Messages.TextBlock => block.type === 'text'
    )

    return textBlock?.text ?? null
  } catch (error) {
    console.error('[issue-parser] Transcript summarization failed:', error)
    return null
  }
}
