import type { TargetKind } from "@/lib/engine/types";
import { HIGH_VOLUME_TOKENS } from "./constants";
import type { RuleConfig, RuleType, Watch } from "./types";

/**
 * Night-Shift Pager rule catalogue: human labels, availability per target kind, defaults and
 * hand-rolled validation (no zod in this repo). One rule per type per watch; the rule id is the
 * stable string `r_<type>` so cooldowns / hysteresis survive edits.
 */

type Meta = Watch["meta"];

interface IntParam { kind: "int"; min: number; max: number; unit: string; label: string }
interface IntListParam { kind: "intList"; min: number; max: number; maxItems: number; unit: string; label: string }
interface EnumParam { kind: "enum"; values: readonly string[]; label: string }
export type RuleParamSpec = IntParam | IntListParam | EnumParam;

export interface RuleSpec {
  type: RuleType;
  label: string;
  description: string;
  /** Severity the rule pages at by default (for UI copy). */
  pages: "critical" | "warn" | "info" | "mixed";
  defaults: Record<string, unknown>;
  params: Record<string, RuleParamSpec>;
  defaultCooldownMin: number;
  available: (kind: TargetKind, meta: Meta) => boolean;
  /** Included (enabled) in the defaults for a fresh watch of this kind. */
  defaultOn: (kind: TargetKind, meta: Meta) => boolean;
}

const hasPool = (kind: TargetKind, meta: Meta) => (kind === "pool" || kind === "token") && !!meta.pool;
const hasUpgradeSlot = (meta: Meta) => !!meta.proxy?.slots.some((s) => s === "eip1967Impl" || s === "eip1967Beacon" || s === "ozImpl");
const hasAdminSurface = (meta: Meta) => !!meta.proxy && (meta.proxy.hasOwnerFn || meta.proxy.slots.some((s) => s === "eip1967Admin" || s === "ozAdmin"));
const isHighVolume = (meta: Meta) => !!meta.token && HIGH_VOLUME_TOKENS.has(meta.token.address.toLowerCase());

export const RULE_CATALOGUE: Record<RuleType, RuleSpec> = {
  lp_liquidity_drop: {
    type: "lp_liquidity_drop",
    label: "LP liquidity pulled",
    description: "Pool liquidity (√k on Aerodrome, active L on Uniswap v3) drops vs its peak inside the window; confirmed by Burn logs.",
    pages: "mixed",
    defaults: { dropBps: 1500, windowMin: 60 },
    params: {
      dropBps: { kind: "int", min: 100, max: 9500, unit: "bps", label: "Drop threshold" },
      windowMin: { kind: "int", min: 5, max: 1440, unit: "min", label: "Window" },
    },
    defaultCooldownMin: 60,
    available: hasPool,
    defaultOn: hasPool,
  },
  price_move: {
    type: "price_move",
    label: "Price move",
    description: "Spot price of the non-WETH token moves vs the oldest sample in the window (pools with ≥ 0.5 WETH depth only).",
    pages: "mixed",
    defaults: { moveBps: 2000, windowMin: 60 },
    params: {
      moveBps: { kind: "int", min: 100, max: 100_000, unit: "bps", label: "Move threshold" },
      windowMin: { kind: "int", min: 5, max: 1440, unit: "min", label: "Window" },
    },
    defaultCooldownMin: 60,
    available: hasPool,
    defaultOn: hasPool,
  },
  spread_bps: {
    type: "spread_bps",
    label: "Base ↔ Robinhood spread",
    description: "Cross-venue $VIBES price spread (Aerodrome vs Robinhood Uniswap v3) exceeds the threshold.",
    pages: "warn",
    defaults: { maxBps: 300 },
    params: { maxBps: { kind: "int", min: 10, max: 5000, unit: "bps", label: "Max spread" } },
    defaultCooldownMin: 120,
    available: (_k, m) => !!m.vibes,
    defaultOn: (_k, m) => !!m.vibes,
  },
  parity_drift: {
    type: "parity_drift",
    label: "OFT 1:1 parity",
    description: "Unbacked supply on Robinhood pages CRITICAL (2 consecutive checks); locked > circulating (in-flight) warns after the persistence window and escalates at 60 min.",
    pages: "mixed",
    defaults: { persistMin: 10 },
    params: { persistMin: { kind: "int", min: 1, max: 1440, unit: "min", label: "Persistence before warning" } },
    defaultCooldownMin: 0,
    available: (_k, m) => !!m.vibes,
    defaultOn: (_k, m) => !!m.vibes,
  },
  escrow_window_opened: {
    type: "escrow_window_opened",
    label: "Challenge window opened",
    description: "Founder requested a tranche: the 72h backer challenge window is open.",
    pages: "critical",
    defaults: {},
    params: {},
    defaultCooldownMin: 0,
    available: (k) => k === "escrow",
    defaultOn: (k) => k === "escrow",
  },
  escrow_window_closing: {
    type: "escrow_window_closing",
    label: "Challenge window closing",
    description: "Time left on an open challenge window crosses each mark.",
    pages: "warn",
    defaults: { marksHours: [24, 6, 1] },
    params: { marksHours: { kind: "intList", min: 1, max: 72, maxItems: 6, unit: "h", label: "Reminder marks" } },
    defaultCooldownMin: 0,
    available: (k) => k === "escrow",
    defaultOn: (k) => k === "escrow",
  },
  escrow_unlock_soon: {
    type: "escrow_unlock_soon",
    label: "Tranche unlock ahead",
    description: "The next tranche unlocks within the lead time (silent heads-up).",
    pages: "info",
    defaults: { leadHours: 72 },
    params: { leadHours: { kind: "int", min: 1, max: 720, unit: "h", label: "Lead time" } },
    defaultCooldownMin: 0,
    available: (k) => k === "escrow",
    defaultOn: (k) => k === "escrow",
  },
  escrow_challenge_or_state: {
    type: "escrow_challenge_or_state",
    label: "Challenge filed / campaign state",
    description: "A backer challenge is filed or resolved, or the campaign moves to Failed / Frozen / Refunding / Completed.",
    pages: "mixed",
    defaults: {},
    params: {},
    defaultCooldownMin: 0,
    available: (k) => k === "escrow",
    defaultOn: (k) => k === "escrow",
  },
  wallet_new_approval: {
    type: "wallet_new_approval",
    label: "New token approval",
    description: "Unlimited, unknown-spender, NFT ApprovalForAll and Permit2 approvals page CRITICAL; bounded approvals to known routers warn.",
    pages: "mixed",
    defaults: { knownSpenders: "warn" },
    params: { knownSpenders: { kind: "enum", values: ["warn", "ignore"], label: "Known spender, bounded amount" } },
    defaultCooldownMin: 0,
    available: (k) => k === "wallet",
    defaultOn: (k) => k === "wallet",
  },
  wallet_activity: {
    type: "wallet_activity",
    label: "Outgoing wallet activity",
    description: "The wallet's nonce increased (an outgoing transaction was signed). Incoming-only balance changes are digest lines.",
    pages: "warn",
    defaults: {},
    params: {},
    defaultCooldownMin: 10,
    available: (k, m) => k === "wallet" && m.isEoa !== false,
    defaultOn: (k, m) => k === "wallet" && m.isEoa !== false,
  },
  proxy_upgrade: {
    type: "proxy_upgrade",
    label: "Upgrade Tripwire",
    description: "Proxy implementation or beacon changes; the alert diffs the risky selectors (mint, blacklist, setTax, pause, upgrade…) added or removed by the new logic.",
    pages: "critical",
    defaults: {},
    params: {},
    defaultCooldownMin: 0,
    available: (k, m) => (k === "token" || k === "contract") && hasUpgradeSlot(m),
    defaultOn: (k, m) => (k === "token" || k === "contract") && hasUpgradeSlot(m),
  },
  admin_change: {
    type: "admin_change",
    label: "Admin / owner / Safe change",
    description: "owner() or proxy admin changes, the owner Safe's threshold is lowered or its owner set changes, or the contract is paused.",
    pages: "mixed",
    defaults: {},
    params: {},
    defaultCooldownMin: 0,
    available: (k, m) => ((k === "token" || k === "contract") && hasAdminSurface(m)) || !!m.vibes,
    defaultOn: (k, m) => ((k === "token" || k === "contract") && hasAdminSurface(m)) || !!m.vibes,
  },
  bridge_peer_change: {
    type: "bridge_peer_change",
    label: "OFT bridge lane guard",
    description: "Either $VIBES adapter's peer changes, the bridge is paused, the pauser or credit-budget limit/window changes (CRITICAL), or lane headroom falls below 25% (warn).",
    pages: "mixed",
    defaults: {},
    params: {},
    defaultCooldownMin: 0,
    available: (_k, m) => !!m.vibes && !!m.bridge?.length,
    defaultOn: (_k, m) => !!m.vibes && !!m.bridge?.length,
  },
  whale_transfer: {
    type: "whale_transfer",
    label: "Whale transfer",
    description: "A single transfer moves ≥ the threshold share of supply (mints and ≥ 5% page CRITICAL). Classified as sell / buy / bridge / burn.",
    pages: "mixed",
    defaults: { minBpsOfSupply: 100 },
    params: { minBpsOfSupply: { kind: "int", min: 1, max: 5000, unit: "bps of supply", label: "Min transfer size" } },
    defaultCooldownMin: 0,
    available: (k, m) => k === "token" && !!m.token && !isHighVolume(m),
    defaultOn: (k, m) => k === "token" && !!m.token && !isHighVolume(m),
  },
  supply_change: {
    type: "supply_change",
    label: "Supply change",
    description: "totalSupply moves vs the armed baseline: increases page CRITICAL (unexpected mint), decreases warn.",
    pages: "mixed",
    defaults: { minBps: 10 },
    params: { minBps: { kind: "int", min: 1, max: 10_000, unit: "bps", label: "Min change" } },
    defaultCooldownMin: 60,
    available: (k, m) => k === "token" && !!m.token,
    defaultOn: (k, m) => k === "token" && !!m.token,
  },
  band_change: {
    type: "band_change",
    label: "Threat band worsened",
    description: "A periodic full Kestrel scan moves the threat band up on two consecutive scans.",
    pages: "warn",
    defaults: { everyMin: 60 },
    params: { everyMin: { kind: "int", min: 15, max: 1440, unit: "min", label: "Re-scan every" } },
    defaultCooldownMin: 0,
    available: () => true,
    defaultOn: () => false,
  },
};

export const RULE_TYPES = Object.keys(RULE_CATALOGUE) as RuleType[];

export const ruleId = (type: RuleType) => `r_${type}`;

export function isRuleType(x: unknown): x is RuleType {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(RULE_CATALOGUE, x);
}

/** A fresh rule of `type` with catalogue defaults. */
export function makeRule(type: RuleType, enabled = true): RuleConfig {
  const spec = RULE_CATALOGUE[type];
  return { id: ruleId(type), type, enabled, ...structuredClone(spec.defaults) } as RuleConfig;
}

export function availableRuleTypes(kind: TargetKind, meta: Meta): RuleType[] {
  return RULE_TYPES.filter((t) => RULE_CATALOGUE[t].available(kind, meta));
}

/** Every available rule for this kind; the default-on ones enabled (spec §6 "Defaults by kind"). */
export function defaultRulesFor(kind: TargetKind, meta: Meta): RuleConfig[] {
  return availableRuleTypes(kind, meta).map((t) => makeRule(t, RULE_CATALOGUE[t].defaultOn(kind, meta)));
}

export type RulesValidation = { ok: true; rules: RuleConfig[] } | { ok: false; error: string };

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

function checkParam(type: RuleType, name: string, spec: RuleParamSpec, v: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  const where = `${type}.${name}`;
  if (spec.kind === "int") {
    if (typeof v !== "number" || !Number.isInteger(v) || v < spec.min || v > spec.max) {
      return { ok: false, error: `${where} must be an integer between ${spec.min} and ${spec.max} (${spec.unit})` };
    }
    return { ok: true, value: v };
  }
  if (spec.kind === "intList") {
    if (!Array.isArray(v) || v.length < 1 || v.length > spec.maxItems) {
      return { ok: false, error: `${where} must be a list of 1-${spec.maxItems} integers` };
    }
    for (const x of v) {
      if (typeof x !== "number" || !Number.isInteger(x) || x < spec.min || x > spec.max) {
        return { ok: false, error: `${where} entries must be integers between ${spec.min} and ${spec.max} (${spec.unit})` };
      }
    }
    return { ok: true, value: [...new Set(v as number[])].sort((a, b) => b - a) };
  }
  if (typeof v !== "string" || !spec.values.includes(v)) {
    return { ok: false, error: `${where} must be one of ${spec.values.join(", ")}` };
  }
  return { ok: true, value: v };
}

/**
 * Validate partial rule input and merge it over `base` (catalogue defaults at arm time, the watch's
 * current rules on PATCH). Each entry is matched by `type` (or by `id` = `r_<type>`). Unknown keys,
 * unknown types, rules unavailable for this target and out-of-range values are rejected with a
 * precise message. Rules not mentioned keep their base config.
 */
export function validateRules(input: unknown, kind: TargetKind, meta: Meta, base?: RuleConfig[]): RulesValidation {
  const current = new Map<RuleType, RuleConfig>((base ?? defaultRulesFor(kind, meta)).map((r) => [r.type, structuredClone(r)]));
  if (input === undefined || input === null) return { ok: true, rules: order([...current.values()]) };
  if (!Array.isArray(input)) return { ok: false, error: "rules must be an array" };
  if (input.length > RULE_TYPES.length) return { ok: false, error: `at most ${RULE_TYPES.length} rules` };
  const seen = new Set<RuleType>();
  for (const raw of input) {
    if (!isObj(raw)) return { ok: false, error: "each rule must be an object" };
    const typeRaw = raw.type ?? (typeof raw.id === "string" && raw.id.startsWith("r_") ? raw.id.slice(2) : undefined);
    if (!isRuleType(typeRaw)) return { ok: false, error: `unknown rule type ${JSON.stringify(String(typeRaw ?? "")).slice(0, 60)}` };
    const type = typeRaw;
    if (raw.id !== undefined && raw.id !== ruleId(type)) return { ok: false, error: `rule id for ${type} must be ${ruleId(type)}` };
    if (seen.has(type)) return { ok: false, error: `duplicate rule ${type}` };
    seen.add(type);
    const spec = RULE_CATALOGUE[type];
    if (!spec.available(kind, meta)) return { ok: false, error: `rule ${type} is not available for this ${kind} target` };
    const rule = (current.get(type) ?? makeRule(type)) as RuleConfig & Record<string, unknown>;
    for (const [k, v] of Object.entries(raw)) {
      if (k === "type" || k === "id") continue;
      if (k === "enabled") {
        if (typeof v !== "boolean") return { ok: false, error: `${type}.enabled must be a boolean` };
        rule.enabled = v;
        continue;
      }
      if (k === "cooldownMin") {
        if (v === null) {
          delete rule.cooldownMin;
          continue;
        }
        if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1440) return { ok: false, error: `${type}.cooldownMin must be an integer between 0 and 1440` };
        rule.cooldownMin = v;
        continue;
      }
      const p = spec.params[k];
      if (!p) return { ok: false, error: `${type} has no parameter "${k.slice(0, 40)}"` };
      const c = checkParam(type, k, p, v);
      if (!c.ok) return c;
      rule[k] = c.value;
    }
    current.set(type, rule);
  }
  return { ok: true, rules: order([...current.values()]) };
}

/** MCP-style input: enable exactly these rule types (others available stay present but disabled). */
export function rulesFromTypes(types: unknown, kind: TargetKind, meta: Meta): RulesValidation {
  if (types === undefined || types === null) return { ok: true, rules: defaultRulesFor(kind, meta) };
  if (!Array.isArray(types) || !types.every((t) => typeof t === "string")) return { ok: false, error: "rules must be an array of rule type strings" };
  const want = new Set<string>(types as string[]);
  for (const t of want) {
    if (!isRuleType(t)) return { ok: false, error: `unknown rule type ${JSON.stringify(t).slice(0, 60)}` };
    if (!RULE_CATALOGUE[t].available(kind, meta)) return { ok: false, error: `rule ${t} is not available for this ${kind} target` };
  }
  return { ok: true, rules: availableRuleTypes(kind, meta).map((t) => makeRule(t, want.has(t))) };
}

function order(rules: RuleConfig[]): RuleConfig[] {
  return rules.sort((a, b) => RULE_TYPES.indexOf(a.type) - RULE_TYPES.indexOf(b.type));
}

/** Plain-text one-liner for a rule's threshold (UI chips, test observations). */
export function describeThreshold(r: RuleConfig): string {
  switch (r.type) {
    case "lp_liquidity_drop": return `−${(r.dropBps / 100).toFixed(1)}% vs peak in ${r.windowMin} min`;
    case "price_move": return `±${(r.moveBps / 100).toFixed(1)}% in ${r.windowMin} min`;
    case "spread_bps": return `|spread| > ${(r.maxBps / 100).toFixed(2)}%`;
    case "parity_drift": return `circulating > locked: immediate · locked > circulating for ≥ ${r.persistMin} min`;
    case "escrow_window_opened": return "tranche requested";
    case "escrow_window_closing": return `marks ${r.marksHours.map((h) => `${h}h`).join(" / ")}`;
    case "escrow_unlock_soon": return `next unlock ≤ ${r.leadHours}h`;
    case "escrow_challenge_or_state": return "challenge filed/resolved or state change";
    case "wallet_new_approval": return `unlimited / unknown spender → critical; known bounded → ${r.knownSpenders}`;
    case "wallet_activity": return "nonce increased";
    case "proxy_upgrade": return "implementation / beacon changed";
    case "admin_change": return "owner / admin / Safe threshold / paused";
    case "bridge_peer_change": return "peer, pause, pauser, limit change · headroom < 25%";
    case "whale_transfer": return `≥ ${(r.minBpsOfSupply / 100).toFixed(2)}% of supply`;
    case "supply_change": return `|Δ supply| ≥ ${(r.minBps / 100).toFixed(2)}%`;
    case "band_change": return `re-scan every ${r.everyMin} min`;
  }
}
