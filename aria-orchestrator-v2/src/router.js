/**
 * Aria model router — ruflo Thompson bandit adapted for three Ollama instances.
 *
 * α (alpha) — qwen3:30b-a3b, GPU  — heavy reasoning, complex decomposition
 * γ (gamma) — qwen3:14b, GPU      — balanced, moderate complexity
 * β (beta)  — qwen3:8b, CPU       — fast, lightweight, tool execution
 *
 * Complexity scored in pure JS — sub-millisecond, no LLM call.
 * Bandit learns from outcomes and adjusts over time.
 * Circuit breaker suppresses a failing instance after 5 consecutive failures.
 *
 * Ported from ruflo model-router.ts. Anthropic API references replaced with
 * Aria Ollama instance references. Tier labels renamed haiku/sonnet/opus →
 * beta/gamma/alpha to match Aria's naming.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ── Constants ────────────────────────────────────────────────────────────────

export const INSTANCES = ['alpha', 'gamma', 'beta'];

const COMPLEXITY_INDICATORS = {
  high: [
    'architect', 'design', 'refactor', 'optimize', 'security', 'audit',
    'complex', 'analyze', 'investigate', 'debug', 'performance', 'scale',
    'distributed', 'concurrent', 'algorithm', 'system', 'integration',
    'incident', 'forensic', 'threat', 'vulnerability', 'compliance',
    'firewall', 'mtls', 'certificate', 'zero-trust', 'siem', 'soc',
    // Infrastructure and provisioning
    'proxmox', 'ssh', 'vm', 'vmid', 'hypervisor', 'provision', 'deploy',
    'api', 'token', 'secret', 'credential', 'password', 'authentication',
    'subnet', 'gateway', 'dns', 'ip', 'network', 'storage', 'disk',
    'node', 'cluster', 'container', 'docker', 'kubernetes',
    'create', 'boot', 'install', 'configure', 'setup',
  ],
  medium: [
    'implement', 'feature', 'add', 'update', 'modify', 'fix', 'test',
    'review', 'validate', 'check', 'improve', 'enhance', 'extend',
    'configure', 'deploy', 'enable', 'disable', 'restart',
  ],
  low: [
    'simple', 'typo', 'comment', 'format', 'rename', 'move', 'copy',
    'delete', 'documentation', 'readme', 'config', 'version', 'bump',
    'who', 'what', 'hello', 'hi', 'thanks', 'help',
  ],
};

// Cost-adjusted rewards — cheaper fast instances rewarded more on success
const BANDIT_REWARDS = {
  alpha: { success: 0.4, failure: 0.0, escalated: 0.0 },
  gamma: { success: 0.7, failure: 0.0, escalated: 0.1 },
  beta:  { success: 1.0, failure: 0.0, escalated: 0.0 },
};

const STATE_PATH = process.env.ROUTER_STATE_PATH || '.swarm/aria-router-state.json';

// ── Beta distribution sampling (Marsaglia-Tsang) ────────────────────────────

function sampleStandardNormal() {
  const u1 = Math.random() || 1e-12;
  const u2 = Math.random();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

function sampleGamma(alpha) {
  if (alpha < 1) {
    const u = Math.random() || 1e-12;
    return sampleGamma(alpha + 1) * Math.pow(u, 1 / alpha);
  }
  const d = alpha - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  while (true) {
    let x, v;
    do { x = sampleStandardNormal(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    const xx = x * x;
    if (u < 1 - 0.0331 * xx * xx) return d * v;
    if (Math.log(u) < 0.5 * xx + d * (1 - v + Math.log(v))) return d * v;
  }
}

function sampleBeta(alpha, beta) {
  if (alpha <= 0 || beta <= 0) return 0.5;
  const x = sampleGamma(alpha);
  const y = sampleGamma(beta);
  const denom = x + y;
  return denom > 0 ? x / denom : 0.5;
}

// ── Complexity bucket ────────────────────────────────────────────────────────

function complexityBucket(score) {
  if (score < 0.4) return 'low';
  if (score < 0.7) return 'med';
  return 'high';
}

function defaultPriors() {
  return {
    alpha: { alpha: 1, beta: 1 },
    gamma: { alpha: 1, beta: 1 },
    beta:  { alpha: 1, beta: 1 },
  };
}

function defaultBucketedPriors() {
  return { low: defaultPriors(), med: defaultPriors(), high: defaultPriors() };
}

// ── State persistence ────────────────────────────────────────────────────────

function loadState() {
  try {
    const fullPath = join(process.cwd(), STATE_PATH);
    if (existsSync(fullPath)) {
      const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
      if (!data.priors) data.priors = defaultBucketedPriors();
      return data;
    }
  } catch { /* ignore */ }
  return {
    totalDecisions: 0,
    instanceDistribution: { alpha: 0, gamma: 0, beta: 0 },
    avgComplexity: 0.5,
    circuitBreakerTrips: 0,
    lastUpdated: new Date().toISOString(),
    learningHistory: [],
    priors: defaultBucketedPriors(),
  };
}

function saveState(state) {
  try {
    const fullPath = join(process.cwd(), STATE_PATH);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    state.lastUpdated = new Date().toISOString();
    writeFileSync(fullPath, JSON.stringify(state, null, 2));
  } catch { /* ignore */ }
}

// ── Router class ─────────────────────────────────────────────────────────────

export class AriaRouter {
  constructor() {
    this.state = loadState();
    this.consecutiveFailures = { alpha: 0, gamma: 0, beta: 0 };
    this.circuitBreakerThreshold = 5;
  }

  /**
   * Analyse message complexity — pure JS, no LLM call.
   * Returns score 0–1.
   */
  analyzeComplexity(message) {
    const lower = message.toLowerCase();
    const words = lower.split(/\s+/);

    const high   = COMPLEXITY_INDICATORS.high.filter(i => lower.includes(i));
    const medium = COMPLEXITY_INDICATORS.medium.filter(i => lower.includes(i));
    const low    = COMPLEXITY_INDICATORS.low.filter(i => lower.includes(i));

    // Lexical
    const avgWordLen = words.reduce((s, w) => s + w.length, 0) / Math.max(1, words.length);
    const lexical = Math.min(1, words.length / 50) * 0.4 +
                    Math.min(1, (avgWordLen - 3) / 7) * 0.6;

    // Semantic
    const semantic = Math.min(1, Math.max(0,
      0.3 + high.length * 0.3 + medium.length * 0.15 + low.length * -0.1
    ));

    // Scope
    const multiFile = /multiple|across|entire|system.wide/i.test(message) ? 0.4 : 0;
    const codeGen   = /implement|create|build|design|write/i.test(message) ? 0.3 : 0;
    const scope     = Math.min(1, multiFile + codeGen + Math.min(0.3, words.length / 100));

    // Uncertainty
    const uncertainPatterns = /not sure|might|maybe|investigate|figure out|unclear|unknown|debug|strange|weird|issue|problem|error|bug/i;
    const uncertainty = Math.min(1, (message.match(uncertainPatterns) || []).length * 0.2);

    const score = Math.min(1, Math.max(0,
      lexical * 0.2 + semantic * 0.35 + scope * 0.25 + uncertainty * 0.2
    ));

    return { score, indicators: { high, medium, low } };
  }

  /**
   * Classify intent and blast radius — fires before any LLM call.
   * Returns { intent, blastRadius }.
   *
   * intent: 'conversational' | 'actionable'
   * blastRadius: 'zero' | 'medium' | 'high'
   */
  classifyIntent(message) {
    const lower = message.toLowerCase();

    // Conversational signals
    // Only truly conversational if short greeting — not if it contains action words
    const hasActionWords = /\b(run|execute|create|scan|ssh|deploy|provision|install|configure|enable|disable|restart|check|list|show|find|get|fetch|connect|access|can you)\b/i.test(lower)
    const conversational = !hasActionWords && (
      /^(hi|hello|hey|thanks|thank you|good|ok|okay|sure|yes|no|bye)[\s?!.]*$/i.test(message.trim()) ||
      /^(who are you|what are you|how are you|what is your name)[\s?!.]*$/i.test(message.trim())
    )

    if (conversational) return { intent: 'conversational', blastRadius: 'zero' };

    // High blast radius — only explicit destructive or write operations on prod systems
    const productionPatterns = /\b(delete|destroy|format|wipe|shutdown|terminate|rollback|revoke)\b/i;
    const highBlast = productionPatterns.test(lower);

    // Stateful change signals — medium blast radius
    const statePatterns = /\b(create|add|update|install|set|apply|push|commit|merge)\b/i;
    const mediumBlast = !highBlast && statePatterns.test(lower);

    const blastRadius = highBlast ? 'high' : mediumBlast ? 'medium' : 'zero';
    return { intent: 'actionable', blastRadius };
  }

  /**
   * Route a message to the best Ollama instance.
   * Returns { instance, complexity, intent, blastRadius, reasoning }.
   */
  route(message) {
    const start = performance.now();
    const { score, indicators } = this.analyzeComplexity(message);
    const { intent, blastRadius } = this.classifyIntent(message);
    const bucket = complexityBucket(score);

    // Base scores
    // β only handles conversational — zero score if actionable
    // γ handles moderate — preferred for actionable low complexity
    // α handles complex — preferred for actionable high complexity
    const baseScores = {
      alpha: intent === 'actionable' ? Math.min(1, score * 2.0) : Math.min(1, score * 0.5),
      gamma: intent === 'actionable' ? Math.min(1, 0.6 + score) : 1 - Math.abs(score - 0.5) * 2,
      beta:  intent === 'conversational' ? Math.max(0, 1 - score * 2) : 0,
    };

    // Circuit breaker — suppress failing instances
    const adjusted = { ...baseScores };
    for (const inst of INSTANCES) {
      if (this.consecutiveFailures[inst] >= this.circuitBreakerThreshold) {
        adjusted[inst] *= 0.1;
      } else if (this.consecutiveFailures[inst] > 0) {
        adjusted[inst] *= 1 - (this.consecutiveFailures[inst] / this.circuitBreakerThreshold) * 0.5;
      }
    }

    // Thompson sampling — multiply base score by Beta(α, β) sample
    const priors = this.state.priors[bucket] ?? defaultPriors();
    const sampled = {
      alpha: adjusted.alpha * sampleBeta(priors.alpha.alpha, priors.alpha.beta),
      gamma: adjusted.gamma * sampleBeta(priors.gamma.alpha, priors.gamma.beta),
      beta:  adjusted.beta  * sampleBeta(priors.beta.alpha,  priors.beta.beta),
    };

    // Pick best
    const instance = Object.entries(sampled)
      .sort((a, b) => b[1] - a[1])[0][0];

    // Track decision
    this.state.totalDecisions++;
    this.state.instanceDistribution[instance] =
      (this.state.instanceDistribution[instance] || 0) + 1;
    const n = this.state.totalDecisions;
    this.state.avgComplexity =
      (this.state.avgComplexity * (n - 1) + score) / n;

    if (this.state.totalDecisions % 20 === 0) saveState(this.state);

    const inferenceMs = performance.now() - start;

    return {
      instance,
      symbol: instance === 'alpha' ? 'α' : instance === 'gamma' ? 'γ' : 'β',
      complexity: score,
      bucket,
      intent,
      blastRadius,
      indicators,
      inferenceMs,
      reasoning: `complexity=${(score * 100).toFixed(0)}% bucket=${bucket} intent=${intent} blastRadius=${blastRadius} → ${instance} (${(inferenceMs).toFixed(2)}ms)`,
    };
  }

  /**
   * Record outcome — updates Thompson bandit priors and circuit breaker.
   */
  recordOutcome(message, instance, outcome) {
    // Circuit breaker
    if (outcome === 'failure') {
      this.consecutiveFailures[instance]++;
    } else {
      this.consecutiveFailures[instance] = 0;
    }

    const { score } = this.analyzeComplexity(message);
    const bucket = complexityBucket(score);

    // Thompson update
    if (!this.state.priors) this.state.priors = defaultBucketedPriors();
    const bp = this.state.priors[bucket];
    const reward = BANDIT_REWARDS[instance]?.[outcome] ?? 0.5;
    bp[instance].alpha += reward;
    bp[instance].beta  += 1 - reward;

    if (outcome === 'failure') this.state.circuitBreakerTrips++;

    // Learning history (last 100)
    this.state.learningHistory.push({
      task: message.slice(0, 100),
      instance,
      complexity: score,
      outcome,
      timestamp: new Date().toISOString(),
    });
    if (this.state.learningHistory.length > 100) {
      this.state.learningHistory = this.state.learningHistory.slice(-100);
    }

    saveState(this.state);
  }

  getStats() {
    return {
      totalDecisions: this.state.totalDecisions,
      instanceDistribution: { ...this.state.instanceDistribution },
      avgComplexity: this.state.avgComplexity,
      circuitBreakerTrips: this.state.circuitBreakerTrips,
      consecutiveFailures: { ...this.consecutiveFailures },
    };
  }
}

export const router = new AriaRouter();
