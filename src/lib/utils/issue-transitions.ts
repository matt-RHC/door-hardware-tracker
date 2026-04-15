const VALID_TRANSITIONS: Record<string, string[]> = {
  created: ['acknowledged', 'duplicate', 'closed'],
  acknowledged: ['awaiting_action', 'blocked', 'resolved', 'duplicate', 'closed'],
  awaiting_action: ['blocked', 'resolved', 'duplicate', 'closed'],
  blocked: ['awaiting_action', 'resolved', 'closed'],
  resolved: ['closed'],
  duplicate: [],  // terminal
  closed: [],     // terminal
}

export function isValidTransition(from: string, to: string): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false
}
