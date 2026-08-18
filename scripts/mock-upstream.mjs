// Synthetic Prefactor Platform API — a faithful, deterministic stand-in for
// the real upstream, used two ways:
//
//   - `npm run demo` boots it next to the dashboard so anyone can see every
//     tab working with realistic data, no Prefactor account required.
//   - The API regression tests (tests/api.test.mjs) boot the dashboard server
//     against it and assert the /api/* contract never drifts.
//
// It implements exactly the endpoints server/sync.mjs calls, with the same
// pagination, sorting, and auth semantics observed on the live API:
//
//   GET /api/v1/account                  → { details: { id } }
//   GET /api/v1/agent                    → { summaries, pagination }
//   GET /api/v1/agent_spans              → { summaries, pagination }  (agent_id required)
//   GET /api/v1/agent_instance           → { summaries, pagination }  (agent_id required)
//   GET /api/v1/agent_instance/:id       → { details }
//   GET /api/v1/alerts/count             → { count }
//   GET /api/v1/risk_profile             → { summaries }
//
// All endpoints require `Authorization: Bearer <token>` and answer 401
// without it, like the real API. Data is generated from a seeded PRNG, so two
// runs with the same seed produce byte-identical datasets — tests can assert
// exact numbers.
//
// Zero dependencies, same as the server it doubles for.

import http from "node:http";

// Deterministic PRNG (mulberry32) — Math.random would make every test flaky.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w) => String(n).padStart(w, "0");

/**
 * Build one account's worth of agents, spans, and instances.
 *
 * Ids are k-sortable (higher sequence = newer), matching the live API's
 * id-descending pagination. Timestamps spread evenly-ish across `days` days
 * ending at `now`, so every chart has a full window of data.
 */
export function makeSyntheticAccount({ seed = 42, days = 14, now = Date.now() } = {}) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const accountId = "acct_demo_0001";
  const agents = [
    { id: "agent_support", name: "Support Concierge", status: "active", type: "assistant", updated_at: new Date(now).toISOString() },
    { id: "agent_research", name: "Research Analyst", status: "active", type: "workflow", updated_at: new Date(now).toISOString() },
    { id: "agent_billing", name: "Billing Reconciler", status: "active", type: "workflow", updated_at: new Date(now).toISOString() },
  ];

  const models = ["claude-sonnet-5", "claude-haiku-4-5", "gpt-4o-mini", "in-house-7b"]; // last one is deliberately unpriced
  const riskLevels = ["low", "low", "low", "medium", "medium", "high", "critical"];

  const spansByAgent = new Map();
  const instancesByAgent = new Map();
  const instanceDetails = new Map();

  let spanSeq = 0;
  let instSeq = 0;
  const horizonMs = days * 86400e3;

  for (const agent of agents) {
    const spans = [];
    const instances = [];
    // Risk profiles: billing agent has none, so the Risk tab's "agents without
    // a profile" callout has something real to show.
    const hasRiskProfile = agent.id !== "agent_billing";
    const runsPerDay = agent.id === "agent_support" ? 10 : 6;

    for (let day = days - 1; day >= 0; day--) {
      for (let run = 0; run < runsPerDay; run++) {
        const startMs = now - day * 86400e3 - Math.floor(rand() * 86400e3 * 0.9);
        const durationMs = 5_000 + Math.floor(rand() * 180_000);
        const instId = `inst_${pad(++instSeq, 8)}`;
        const roll = rand();
        const status = roll < 0.82 ? "complete" : roll < 0.93 ? "failed" : roll < 0.97 ? "terminated" : "active";
        const inst = {
          id: instId,
          status,
          purpose: rand() < 0.9 ? "live" : "eval",
          started_at: new Date(startMs).toISOString(),
          finished_at: status === "active" ? null : new Date(startMs + durationMs).toISOString(),
          agent_id: agent.id,
          termination_reason:
            status === "terminated" ? pick(["policy breach: refund over limit", "runaway loop detected", "manual stop from ops"]) : null,
        };
        instances.push(inst);

        // Quality detail: most finished runs carry an external eval payload.
        const withQuality = status !== "active" && rand() < 0.75;
        instanceDetails.set(instId, {
          ...inst,
          quality_payload: withQuality
            ? {
                scores: { accuracy: Math.round((0.6 + rand() * 0.4) * 100) / 100, helpfulness: Math.round((0.5 + rand() * 0.5) * 100) / 100 },
                passed: rand() < 0.8,
                evaluator: "demo-evals v1",
              }
            : null,
          quality_summary:
            withQuality && rand() < 0.5
              ? `Resolved in ${(durationMs / 1000).toFixed(0)}s with ${status === "complete" ? "no" : "1"} escalation.`
              : null,
        });

        // Spans inside the run: llm calls, tool calls, and oversight signals.
        const llmCalls = 2 + Math.floor(rand() * 4);
        for (let c = 0; c < llmCalls; c++) {
          const model = pick(models);
          const prompt = 300 + Math.floor(rand() * 4000);
          const completion = 50 + Math.floor(rand() * 1200);
          const failed = rand() < 0.04;
          const spanStart = startMs + Math.floor((c / llmCalls) * durationMs);
          const spanDur = 400 + Math.floor(rand() * 9000);
          const level = hasRiskProfile ? pick(riskLevels) : null;
          spans.push({
            id: `sp_${pad(++spanSeq, 8)}`,
            status: failed ? "failed" : "complete",
            schema_name: "ai-sdk:llm",
            schema_title: "LLM call",
            started_at: new Date(spanStart).toISOString(),
            finished_at: new Date(spanStart + spanDur).toISOString(),
            parent_span_id: null,
            agent_instance_id: instId,
            agent_id: agent.id,
            purpose: inst.purpose,
            risk_level: level,
            risk_score: level ? Math.floor(rand() * 100) : null,
            sensitive_encoding: false,
            payload: {
              token_usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion },
              inputs: { ai: { model: { id: model } } },
              // Both finish-reason shapes seen in the wild, plus error spans.
              ...(failed
                ? { error: { error_type: pick(["RateLimitError", "Timeout", "ToolExecutionError"]) } }
                : rand() < 0.5
                  ? { outputs: { ai: { finishReason: pick(["stop", "tool-calls"]) } } }
                  : { outputs: { ai: { finishReason: { unified: pick(["stop", "length"]), raw: "end_turn" } } } }),
            },
          });
        }

        // Tool span carrying a $sensitive-wrapped value.
        if (rand() < 0.4) {
          const spanStart = startMs + Math.floor(rand() * durationMs);
          spans.push({
            id: `sp_${pad(++spanSeq, 8)}`,
            status: "complete",
            schema_name: "ai-sdk:tool:lookup_customer",
            schema_title: "Tool: lookup_customer",
            started_at: new Date(spanStart).toISOString(),
            finished_at: new Date(spanStart + 1200).toISOString(),
            parent_span_id: null,
            agent_instance_id: instId,
            agent_id: agent.id,
            purpose: inst.purpose,
            risk_level: hasRiskProfile ? "medium" : null,
            risk_score: hasRiskProfile ? 35 + Math.floor(rand() * 30) : null,
            sensitive_encoding: false,
            payload: {
              inputs: { customer_email: { $sensitive: "string", labels: [pick(["email", "pii", "account-number"])], value: "redacted@example.com" } },
            },
          });
        }

        // HITL approval flow on some support runs.
        if (agent.id === "agent_support" && rand() < 0.15) {
          const spanStart = startMs + Math.floor(rand() * durationMs);
          spans.push({
            id: `sp_${pad(++spanSeq, 8)}`,
            status: "complete",
            schema_name: "hitl:human-approval",
            schema_title: "Human approval",
            started_at: new Date(spanStart).toISOString(),
            finished_at: new Date(spanStart + 60_000).toISOString(),
            parent_span_id: null,
            agent_instance_id: instId,
            agent_id: agent.id,
            purpose: inst.purpose,
            risk_level: hasRiskProfile ? "high" : null,
            risk_score: hasRiskProfile ? 60 + Math.floor(rand() * 25) : null,
            sensitive_encoding: false,
            payload: { inputs: { decision: pick(["approved", "denied"]) } },
          });
        }

        // Human feedback: thumbs via prefactor:quality, scales via user:feedback.
        if (status !== "active" && rand() < 0.3) {
          const spanStart = startMs + durationMs;
          const thumbs = rand() < 0.8;
          spans.push({
            id: `sp_${pad(++spanSeq, 8)}`,
            status: "complete",
            schema_name: thumbs ? "prefactor:quality" : "user:feedback",
            schema_title: thumbs ? "Quality feedback" : "User feedback",
            started_at: new Date(spanStart).toISOString(),
            finished_at: new Date(spanStart + 200).toISOString(),
            parent_span_id: null,
            agent_instance_id: instId,
            agent_id: agent.id,
            purpose: inst.purpose,
            risk_level: null,
            risk_score: null,
            sensitive_encoding: false,
            payload: thumbs ? { inputs: { feedback: { rating: rand() < 0.75 ? "up" : "down" } } } : { inputs: { rating: pick(["3", "4", "5"]) } },
          });
        }
      }
    }

    // Newest first, exactly like the live API's id-descending sort.
    spans.sort((a, b) => (a.id < b.id ? 1 : -1));
    instances.sort((a, b) => (a.id < b.id ? 1 : -1));
    spansByAgent.set(agent.id, spans);
    instancesByAgent.set(agent.id, instances);
  }

  return { accountId, agents, spansByAgent, instancesByAgent, instanceDetails, horizonMs };
}

/**
 * Start the mock API. Returns { server, port, url, data, requests, close() }.
 * Pass port 0 to let the OS pick — tests do, so parallel runs never collide.
 */
export function createMockUpstream({ token = "demo-token", seed = 42, days = 14, port = 0, host = "127.0.0.1" } = {}) {
  const data = makeSyntheticAccount({ seed, days });
  const requests = []; // { method, path, authorized } — tests assert on these

  const paginate = (rows, url) => {
    const size = Math.max(1, Number(url.searchParams.get("pagination[page_size]") ?? 100));
    const offset = Math.max(0, Number(url.searchParams.get("pagination[offset]") ?? 0));
    const page = rows.slice(offset, offset + size);
    const more = offset + size < rows.length;
    return { summaries: page, pagination: more ? { next_page_offset: offset + size } : {} };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const authorized = (req.headers.authorization ?? "") === `Bearer ${token}`;
    requests.push({ method: req.method, path: url.pathname, authorized });

    const json = (status, obj) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (!authorized) return json(401, { error: "unauthorized" });

    const path = url.pathname;
    if (path === "/api/v1/account") return json(200, { details: { id: data.accountId, name: "Demo Account" } });
    if (path === "/api/v1/agent") return json(200, paginate(data.agents, url));
    if (path === "/api/v1/agent_spans") {
      const rows = data.spansByAgent.get(url.searchParams.get("agent_id")) ?? [];
      return json(200, paginate(rows, url));
    }
    if (path === "/api/v1/agent_instance") {
      const rows = data.instancesByAgent.get(url.searchParams.get("agent_id")) ?? [];
      return json(200, paginate(rows, url));
    }
    const detail = /^\/api\/v1\/agent_instance\/([^/]+)$/.exec(path);
    if (detail) {
      const d = data.instanceDetails.get(detail[1]);
      return d ? json(200, { details: d }) : json(404, { error: "not found" });
    }
    if (path === "/api/v1/alerts/count") return json(200, { count: 3 });
    if (path === "/api/v1/risk_profile") {
      return json(200, { summaries: [{ id: "rp_standard", name: "Standard guardrails" }] });
    }
    return json(404, { error: `no such endpoint: ${path}` });
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server.address().port));
  });

  return {
    server,
    data,
    requests,
    token,
    /** Resolves with the bound port (useful with port 0). */
    ready: ready.then((p) => ({ port: p, url: `http://${host}:${p}` })),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Runnable directly: `node scripts/mock-upstream.mjs [port]`.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("mock-upstream.mjs")) {
  const port = Number(process.argv[2] ?? 9788);
  const mock = createMockUpstream({ port });
  mock.ready.then(({ url }) => {
    console.log(`Synthetic Prefactor API listening at ${url} (token: ${mock.token})`);
  });
}
