import { supabase } from './supabase.js';

export type Agent =
  | 'intel'
  | 'product'
  | 'listing'
  | 'customer_service'
  | 'orchestrator'
  | 'system';

export type Severity = 'info' | 'success' | 'warning' | 'error';

export interface LogEntry {
  agent: Agent;
  action: string;
  description: string;
  severity?: Severity;
  metadata?: Record<string, unknown>;
}

/**
 * Log an agent action to both stdout (for Railway log tailing)
 * and the activity table (for the dashboard's live feed).
 */
export async function log(entry: LogEntry): Promise<void> {
  const sev = entry.severity ?? 'info';
  console.log(`[${sev}] [${entry.agent}] ${entry.action}: ${entry.description}`);

  const { error } = await supabase.from('activity').insert({
    agent: entry.agent,
    action: entry.action,
    description: entry.description,
    severity: sev,
    metadata: entry.metadata ?? {}
  });

  if (error) {
    console.error('failed to write activity row:', error.message);
  }
}
