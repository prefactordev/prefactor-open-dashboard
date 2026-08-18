// "Actions taken" — oversight interventions on agent runs, as distinct from
// the agent's own activity:
//
//   hitl       — human-in-the-loop approval flows (Prefactor triggers an
//                approval, a human approves/denies in Slack, the whole flow is
//                recorded). Matched on whole schema-name SEGMENTS equal to
//                "hitl"/"approval"/"approvals" (or starting "human-approval"),
//                verified against the real shipped schema `hitl:human-approval`.
//                Segments, not substrings: any span with a `tool` segment is
//                excluded, so `…:tool:approve_refund` and
//                `…:tool:escalate_to_human` are the agent acting, not a human.
//   killswitch — instances terminated by an external party (the terminate
//                endpoint sets termination_reason; only ACTIVE runs can be
//                killed, so this is always an intervention)
//   feedback   — a human rated a run. Detected by the PRESENCE OF A RATING
//                (payload.inputs.feedback.rating or payload.inputs.rating),
//                never by schema name: `prefactor:quality` carries thumbs in
//                some accounts but is a quality/eval record in others
//                (`{report, result}`), and an eval record is not an action.
//
// NOT counted: quality-evaluation records (spans with purpose "quality") —
// those are audit entries about a score being written, not interventions.
//
// The headline metric is actions / total spans: how much oversight the
// account exercises relative to how much the agents do.

import type { InstanceSummary, Span } from "../types";
import { dayKey, dayRange, getPath, unwrapSensitive } from "./util";

export const ACTION_KINDS = ["hitl", "killswitch", "feedback"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export interface ActionsSummary {
  totalActions: number;
  totalSpans: number;
  /** actions / total spans (null when there are no spans). */
  rate: number | null;
  byKind: Record<ActionKind, number>;
  byDay: Array<{ day: string } & Record<ActionKind, number>>;
  /** Most recent killswitch events, newest first. */
  recentKills: Array<{ instanceId: string; agentId: string; reason: string; when: string | null }>;
}

/**
 * HITL detection, matched on whole schema-name SEGMENTS rather than a
 * substring. A substring match counted the agent's own tool calls — e.g.
 * `ai-sdk:tool:approve_refund` — as human interventions, which inflates the
 * headline metric with the opposite of an intervention.
 */
function isHitl(schemaName: string): boolean {
  const segments = schemaName.toLowerCase().split(":");
  // A tool call is the agent acting, never a human approving.
  if (segments.includes("tool")) return false;
  return segments.some((seg) => seg === "hitl" || seg === "approval" || seg === "approvals" || /^human[-_]approval/.test(seg));
}

/** The human rating on a span, or null if it carries none. */
export function ratingOf(span: Span): string | null {
  const raw = unwrapSensitive(getPath(span, "payload.inputs.feedback.rating") ?? getPath(span, "payload.inputs.rating"));
  return typeof raw === "string" && raw !== "" ? raw : null;
}

export function summarizeActions(spans: Span[], instances: InstanceSummary[], windowStart: string, windowEnd: string): ActionsSummary {
  const byKind: Record<ActionKind, number> = { hitl: 0, killswitch: 0, feedback: 0 };
  const days = new Map<string, Record<ActionKind, number>>();
  const bump = (kind: ActionKind, when: string | null) => {
    byKind[kind]++;
    if (!when) return;
    const day = dayKey(when);
    const d = days.get(day) ?? { hitl: 0, killswitch: 0, feedback: 0 };
    d[kind]++;
    days.set(day, d);
  };

  const recentKills: ActionsSummary["recentKills"] = [];
  for (const i of instances) {
    if (i.termination_reason) {
      bump("killswitch", i.finished_at ?? i.started_at);
      recentKills.push({ instanceId: i.id, agentId: i.agent_id, reason: String(i.termination_reason), when: i.finished_at ?? i.started_at });
    }
  }
  for (const s of spans) {
    if (isHitl(s.schema_name)) bump("hitl", s.started_at);
    else if (ratingOf(s)) bump("feedback", s.started_at);
  }

  const totalActions = byKind.hitl + byKind.killswitch + byKind.feedback;
  return {
    totalActions,
    totalSpans: spans.length,
    rate: spans.length ? totalActions / spans.length : null,
    byKind,
    byDay: dayRange(windowStart, windowEnd).map((day) => ({ day, ...(days.get(day) ?? { hitl: 0, killswitch: 0, feedback: 0 }) })),
    recentKills: recentKills.sort((a, b) => String(b.when).localeCompare(String(a.when))).slice(0, 6),
  };
}
