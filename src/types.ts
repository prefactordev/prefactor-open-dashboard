// Shapes read off live Prefactor Platform API responses (July 2026).
// Unknown fields are carried, never required — the API adds fields over time.

export interface Agent {
  id: string;
  name: string;
  status: string;
  type: string;
  updated_at?: string | null;
}

/** One row from GET /api/v1/agent_spans. */
export interface Span {
  id: string;
  status: string; // pending | active | complete | failed | cancelled
  schema_name: string; // namespaced, e.g. "ai-sdk:llm", "prefactor:quality"
  schema_title?: string | null;
  started_at: string | null;
  finished_at: string | null;
  parent_span_id: string | null;
  agent_instance_id: string | null;
  agent_id: string | null;
  purpose?: string | null;
  // Risk fields populate only when the request passes include_risk_level=true
  // AND the agent has a risk_profile_id — otherwise they are null.
  risk_level?: string | null; // low | medium | high | critical
  risk_score?: number | null;
  sensitive_encoding?: boolean;
  /** Precomputed by the server's projection: labels of $sensitive-marked values. */
  sensitive_labels?: string[];
  /**
   * Only the fields the dashboard reads, normalised by the server's
   * projection: token_usage, inputs.ai.model.id, inputs.feedback.rating,
   * outputs.ai.finishReason.unified, error.error_type. Raw API payloads are
   * never cached, so anything else the API returns is absent here.
   */
  payload?: Record<string, unknown> | null;
}

/** One row from GET /api/v1/agent_instance (list). */
export interface InstanceSummary {
  id: string;
  status: string; // active | complete | failed | cancelled
  purpose?: string | null; // live | smoke_test | eval
  started_at: string | null;
  finished_at: string | null;
  agent_id: string;
  termination_reason?: string | null;
}

/** Instance with its quality fields (the server's detail pass fills these). */
export interface InstanceDetail extends InstanceSummary {
  /** True once the server has read this instance's quality fields. */
  detail_checked?: boolean;
  // quality_payload is written by YOUR code (agent instrumentation or an
  // external eval tool) via PUT; quality_summary is rendered by Prefactor
  // from the quality_schema template declared at register time.
  quality_payload?: Record<string, unknown> | null;
  quality_summary?: string | null;
}

/** GET /api/data response — the server's cached snapshot for one scope. */
export interface DataSnapshot {
  accountId: string | null;
  agents: Agent[];
  spans: Span[];
  instances: InstanceDetail[];
  riskProfiles: RiskProfile[];
  alerts: number | null;
  meta: {
    effectiveStart: string;
    clipped: boolean;
    backfillingAgents: number;
    historyComplete: boolean;
    horizonLimited: boolean;
    horizonDays: number;
    cachedSpans: number;
    lastSyncAt: string | null;
    syncError: string | null;
    detailChecked: number;
  };
}

export interface RiskProfile {
  id: string;
  name?: string;
}

export type TimeRangeKey = "24h" | "7d" | "30d" | "90d";
