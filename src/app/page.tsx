import Link from "next/link";
import { CONTRACTS, LIVE_DEMO_PRESETS } from "@/config/contracts";
import { Countdown } from "@/components/countdown";
import { AddrLink, BandBadge, ChainBadge, cx, Panel, ScoreGauge, SectionLabel, SEVERITY_COLOR, Stat, TxLink } from "@/components/ui";
import { readEscrow } from "@/lib/engine/escrow";
import { getBridgeParity } from "@/lib/engine/parity";
import { scanTarget } from "@/lib/engine/scan";
import { explorerBlock, fmtBps, fmtCompact, fmtUnits } from "@/lib/format";

export const revalidate = 60;

const PILLARS = [
  { n: "01", tab: "briefing", title: "While You Slept Briefing", body: "Paste any Base or Robinhood Chain wallet, token, pool or escrow. Get a 0–100 Overnight Threat Score from open ERC-20 + Permit2 approvals, 8-hour LP depth change, whale concentration and bytecode posture — plus a plain-English Morning Desk Brief." },
  { n: "02", tab: "bunker", title: "Atomic Panic Bunker", body: "Revoke every risky approval and unwind exposed tokens to USDC in ONE signature with EIP-5792 wallet_sendCalls on Smart Wallets. Standard EOAs get a guided sequential fallback. Every call is simulated before you sign." },
  { n: "03", tab: "chaos", title: "Simulate the Rug", body: "Whale dumps 100%. Half the LP is pulled. Exact BigInt constant-product and Uniswap v3 active-range math on live reserves shows your surviving exit value before it happens." },
  { n: "04", tab: "parity", title: "Base ↔ Robinhood Parity Radar", body: "Dual-RPC proof that $VIBES locked in the Base OFT adapter equals Robinhood circulating supply — to the wei — plus live Aerodrome vs Uniswap v3 dislocation net of fees." },
  { n: "05", tab: "shield", title: "Vibestarter Backer Shield", body: "Every tranche escrow on both chains: 10% kickstart + six 15% monthly releases, live 72-hour challenge-window countdowns, LP lock, Origin Capsule provenance and founder signals." },
  { n: "06", tab: "briefing", title: "Bytecode & EIP-1967 X-Ray", body: "Opcode-level walk of eth_getCode plus EIP-1967 implementation/admin/beacon slots. Flags mutable proxies, single-key owners vs Safe m-of-n, and mint / blacklist / pause / tax / upgrade selectors." },
  { n: "07", tab: "agents", title: "Agent Pre-Trade Gate", body: "GET /api/v1/guard returns ALLOW | WARN | BLOCK for autonomous agents. Free preview tier, full verdicts behind HTTP 402 x402 USDC on Base. Also served as an MCP server at /api/mcp." },
  { n: "08", tab: "pager", title: "Night-Shift Pager", body: "Arm thresholds — LP drop, cross-chain spread, challenge window opened — and dispatch a live webhook or Telegram page carrying a 1-click deep link straight into the Panic Bunker." },
];

async function loadLanding() {
  const [scan, parity, escrow] = await Promise.all([
    scanTarget(8453, CONTRACTS.base.vibesToken, { useLlm: false }).catch(() => null),
    getBridgeParity({ overnight: false }).catch(() => null),
    readEscrow(8453, CONTRACTS.base.vibesGenesisEscrow).catch(() => null),
  ]);
  return { scan, parity, escrow };
}

export default async function Landing() {
  const { scan, parity, escrow } = await loadLanding();
  const nowSec = Math.floor(Date.now() / 1000);
  const openWindow = escrow?.tranches.find((t) => t.status === "CHALLENGE_WINDOW") ?? null;
  const vibesPreset = LIVE_DEMO_PRESETS[0];

  return (
    <div className="mx-auto max-w-[1400px] px-4">
      {/* ───────────── HERO ───────────── */}
      <section className="grid gap-10 pt-14 pb-12 lg:grid-cols-[1.15fr_1fr] lg:pt-20">
        <div>
          <SectionLabel n="00">Night Shift Sentinel · Base 8453 ↔ Robinhood Chain 4663</SectionLabel>
          <h1 className="mt-5 font-serif text-[52px] leading-[1.02] text-ink md:text-[68px]">
            Stay asleep.
            <br />
            <em className="text-phosphor">Kestrel</em> watches the chain.
          </h1>
          <p className="mt-6 max-w-xl text-[16px] leading-relaxed text-ink-2">
            Autonomous overnight risk, liquidity, bridge-parity and tranche-escrow sentinel. Kestrel reads Base and Robinhood Chain directly over RPC, scores
            what changed while you slept, and pre-stages a one-signature rescue for when it matters.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Link href="/app" className="group inline-flex items-center gap-2 rounded-[2px] bg-phosphor px-5 py-3 mono text-[13px] font-semibold text-canvas transition-colors hover:bg-[#a6e698]">
              LAUNCH APP <span className="transition-transform group-hover:translate-x-0.5">→</span>
            </Link>
            <Link href={`/app?target=${vibesPreset.targetAddress}&chain=${vibesPreset.chainId}`} className="inline-flex items-center gap-2 rounded-[2px] border border-hair-strong px-5 py-3 mono text-[13px] text-ink hover:border-phosphor/60 hover:text-phosphor">
              Scan $VIBES live
            </Link>
            <Link href="/how-it-works" className="mono text-[12px] text-ink-3 underline decoration-white/10 underline-offset-4 hover:text-ink">
              How it works
            </Link>
          </div>
          <p className="mt-5 mono text-[11px] text-ink-3">No wallet connect required · Zero mock data · Every number links to an explorer</p>
        </div>

        {/* Live threat card */}
        <Panel
          title="Live scan · $VIBES on Base"
          n="LIVE"
          right={scan ? <a href={explorerBlock(8453, scan.block.number)} target="_blank" rel="noreferrer" className="mono text-[11px] text-ink-3 hover:text-ink">block #{BigInt(scan.block.number).toLocaleString("en-US")} ↗</a> : null}
        >
          {scan ? (
            <div>
              <ScoreGauge score={scan.score} band={scan.band} />
              <ul className="mt-5 space-y-2">
                {scan.findings.slice(0, 5).map((f) => (
                  <li key={f.id} className="flex items-start gap-2.5 text-[13px]">
                    <span className={cx("mt-[3px] mono text-[10px] uppercase", SEVERITY_COLOR[f.severity])}>{f.severity === "critical" ? "CRIT" : f.severity === "warn" ? "WARN" : "INFO"}</span>
                    <span className="text-ink-2">
                      <span className="text-ink">{f.title}</span> — {f.detail}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-5 border-t hairline pt-4">
                <p className="label mb-1.5">Morning Desk Brief</p>
                <p className="text-[13px] leading-relaxed text-ink-2">{scan.brief.text}</p>
              </div>
            </div>
          ) : (
            <p className="mono text-[12px] text-ink-3">Live RPC read temporarily unavailable — open the app to retry.</p>
          )}
        </Panel>
      </section>

      {/* ───────────── LIVE PROOF STRIP ───────────── */}
      <section className="grid gap-px overflow-hidden border hairline bg-white/[0.06] md:grid-cols-4">
        <div className="bg-surface p-5">
          <Stat
            label="$VIBES OFT 1:1 parity"
            value={parity ? (parity.verified ? "VERIFIED" : "DRIFT") : "—"}
            tone={parity?.verified ? "phosphor" : "warn"}
            sub={parity ? `${fmtCompact(parity.lockedOnBase, 18)} locked = ${fmtCompact(parity.rhCirculating, 18)} circulating · Δ ${fmtUnits(parity.delta, 18)}` : undefined}
          />
        </div>
        <div className="bg-surface p-5">
          <Stat
            label="Base ↔ Robinhood spread"
            value={parity?.spreadBps != null ? fmtBps(parity.spreadBps) : "—"}
            tone={parity?.spreadBps != null && Math.abs(parity.spreadBps) >= 300 ? "warn" : undefined}
            sub={parity?.cheaperVenue ? `VIBES cheaper on ${parity.cheaperVenue === "base" ? "Base Aerodrome" : "Robinhood Uniswap v3"} · fees ${parity.feeDragBps} bps` : undefined}
          />
        </div>
        <div className="bg-surface p-5">
          <Stat
            label="Genesis escrow · challenge window"
            value={openWindow ? <Countdown to={openWindow.windowEndsAt} initialNow={nowSec} /> : escrow ? "No window open" : "—"}
            tone={openWindow ? "warn" : undefined}
            sub={openWindow ? `${openWindow.label} · ${fmtUnits(openWindow.amount, 18, 2)} ETH requested` : escrow ? `${escrow.stateLabel} · next tranche ${escrow.nextTranche}` : undefined}
          />
        </div>
        <div className="bg-surface p-5">
          <Stat
            label="Escrowed ETH remaining"
            value={escrow ? `${fmtUnits(escrow.escrowBalance, 18, 2)} ETH` : "—"}
            sub={escrow ? `of ${fmtUnits(escrow.totalRaised, 18, 2)} ETH raised · ${escrow.contributorCount ?? "—"} backers` : undefined}
          />
        </div>
      </section>

      {/* ───────────── PROBLEM ───────────── */}
      <section className="grid gap-10 py-24 lg:grid-cols-[1fr_1.4fr]">
        <div>
          <SectionLabel n="01">The problem</SectionLabel>
          <h2 className="mt-4 font-serif text-[40px] leading-[1.08] text-ink">Markets run 24/7. Bridges, pools and escrows don&apos;t wait for your alarm.</h2>
        </div>
        <div className="grid gap-px border hairline bg-white/[0.06] sm:grid-cols-3">
          {[
            { k: "03:42 UTC", t: "An approval you forgot gets drained", d: "Unlimited ERC-20 and Permit2 allowances outlive the dApps you granted them to. Revoking eight of them one MetaMask popup at a time — at 3am, mid-exploit — fails halfway." },
            { k: "2 chains", t: "Bridged supply can quietly de-peg", d: "$VIBES lives on Base and Robinhood Chain through a LayerZero OFT. If locked ≠ circulating, someone minted unbacked supply. Nobody checks the invariant block by block." },
            { k: "72 hours", t: "Backers miss the only window that matters", d: "Vibestarter founders request each 15% tranche publicly; backers have exactly 72 hours to challenge. Most find out after the money moved." },
          ].map((x) => (
            <div key={x.k} className="bg-surface p-5">
              <p className="mono text-[12px] text-phosphor">{x.k}</p>
              <p className="mt-3 text-[15px] text-ink">{x.t}</p>
              <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{x.d}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───────────── PILLARS ───────────── */}
      <section className="pb-24">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <SectionLabel n="02">Eight instruments, one desk</SectionLabel>
            <h2 className="mt-4 font-serif text-[40px] leading-[1.08] text-ink">Everything a night-shift operator needs.</h2>
          </div>
          <Link href="/app" className="mono text-[12px] text-phosphor hover:underline">Open the workspace →</Link>
        </div>
        <div className="mt-8 grid gap-px border hairline bg-white/[0.06] sm:grid-cols-2 lg:grid-cols-4">
          {PILLARS.map((p) => (
            <Link key={p.n} href={p.tab === "agents" ? "/agents" : `/app?tab=${p.tab}`} className="group flex flex-col bg-surface p-5 transition-colors hover:bg-elevated">
              <span className="mono text-[11px] text-ink-3">{p.n}</span>
              <span className="mt-3 text-[15px] text-ink group-hover:text-phosphor">{p.title}</span>
              <span className="mt-2 flex-1 text-[13px] leading-relaxed text-ink-3">{p.body}</span>
              <span className="mt-4 mono text-[11px] text-ink-3 group-hover:text-phosphor">open →</span>
            </Link>
          ))}
        </div>
      </section>

      {/* ───────────── BACKER SHIELD + PARITY PREVIEW ───────────── */}
      <section className="grid gap-6 pb-24 lg:grid-cols-2">
        <Panel title="Backer Shield · Genesis $VIBES escrow" n="05" right={<ChainBadge chainId={8453} />}>
          {escrow ? (
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[15px] text-ink">{escrow.title ?? "Vibestarter"}</p>
                <AddrLink chainId={8453} address={escrow.address} />
              </div>
              <ol className="mt-5 grid grid-cols-7 gap-1">
                {escrow.tranches.map((t) => {
                  const tone =
                    t.status === "PAID" ? "bg-phosphor/70" : t.status === "CHALLENGE_WINDOW" ? "bg-warn" : t.status === "CHALLENGED" || t.status === "HALTED" ? "bg-crit" : t.status === "CLAIMABLE" || t.status === "ELIGIBLE" ? "bg-base/60" : "bg-white/10";
                  return (
                    <li key={t.index} title={`${t.label} · ${t.status}`}>
                      <div className={cx("h-2", tone)} />
                      <p className="mt-1.5 mono text-[10px] text-ink-3">{t.index === 0 ? "KICK" : `M${t.index}`}</p>
                      <p className="mono text-[10px] text-ink-2">{t.bps / 100}%</p>
                    </li>
                  );
                })}
              </ol>
              <div className="mt-5 grid grid-cols-2 gap-4 border-t hairline pt-4">
                <Stat label="State (onchain)" value={escrow.stateLabel} tone={escrow.state === 3 ? "phosphor" : "warn"} />
                <Stat label="Permanent LP" value={escrow.lpCreated ? "LOCKED" : "NOT CREATED"} tone={escrow.lpCreated ? "phosphor" : "warn"} sub={escrow.lpLockTxHash ? <TxLink chainId={8453} hash={escrow.lpLockTxHash} label="lock tx" /> : undefined} />
              </div>
              <Link href="/app?tab=shield" className="mt-5 inline-block mono text-[12px] text-phosphor hover:underline">All escrows on Base + Robinhood →</Link>
            </div>
          ) : (
            <p className="mono text-[12px] text-ink-3">Escrow read unavailable.</p>
          )}
        </Panel>

        <Panel title="Parity Radar · $VIBES OFT" n="04" right={<span className="flex gap-1.5"><ChainBadge chainId={8453} /><ChainBadge chainId={4663} /></span>}>
          {parity ? (
            <div>
              <div className="grid grid-cols-2 gap-4">
                <Stat label="Locked on Base adapter" value={fmtCompact(parity.lockedOnBase, 18)} tone="base" sub={<AddrLink chainId={8453} address={CONTRACTS.base.vibesBridgeAdapter} />} />
                <Stat label="Circulating on Robinhood" value={fmtCompact(parity.rhCirculating, 18)} tone="rh" sub={<AddrLink chainId={4663} address={CONTRACTS.robinhood.vibesReserveAdapter} label="reserve adapter" />} />
              </div>
              <div className="mt-5 border-t hairline pt-4 mono text-[12px] text-ink-2">
                <p>
                  <span className="text-ink-3">invariant </span>BaseAdapter.balanceOf == RH.totalSupply − RHReserve.balanceOf
                </p>
                <p className="mt-1">
                  <span className="text-ink-3">delta </span>
                  <span className={parity.verified ? "text-phosphor" : "text-warn"}>{fmtUnits(parity.delta, 18)} VIBES</span>{" "}
                  <BandBadge band={parity.verified ? "NOMINAL" : "ELEVATED"} className="ml-2" />
                </p>
                <p className="mt-3">
                  <span className="text-ink-3">VIBES/WETH </span>Base {fmtCompact(parity.baseVibesPerWeth, 18)} · RH {fmtCompact(parity.rhVibesPerWeth, 18)} · spread{" "}
                  {parity.spreadBps != null ? fmtBps(parity.spreadBps) : "—"}
                </p>
              </div>
              <Link href="/app?tab=parity" className="mt-5 inline-block mono text-[12px] text-phosphor hover:underline">Open Parity Radar →</Link>
            </div>
          ) : (
            <p className="mono text-[12px] text-ink-3">Parity read unavailable.</p>
          )}
        </Panel>
      </section>

      {/* ───────────── PRESETS ───────────── */}
      <section className="pb-24">
        <SectionLabel n="03">One-click live mainnet targets</SectionLabel>
        <div className="mt-6 grid gap-px border hairline bg-white/[0.06] md:grid-cols-4">
          {LIVE_DEMO_PRESETS.map((p) => (
            <Link key={p.id} href={`/app?target=${p.targetAddress}&chain=${p.chainId}`} className="group bg-surface p-5 hover:bg-elevated">
              <div className="flex items-center justify-between">
                <ChainBadge chainId={p.chainId} />
                <span className="mono text-[10px] text-ink-3">{p.kind.toUpperCase()}</span>
              </div>
              <p className="mt-4 text-[14px] text-ink group-hover:text-phosphor">{p.label}</p>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{p.description}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* ───────────── PIPELINE ───────────── */}
      <section className="pb-24">
        <SectionLabel n="06">How a night shift runs</SectionLabel>
        <ol className="mt-6 grid gap-px border hairline bg-white/[0.06] md:grid-cols-5">
          {[
            ["READ", "eth_getCode, EIP-1967 slots, getReserves / slot0, allowances, Permit2, Transfer & Approval logs — straight from Base and Robinhood RPCs."],
            ["SCORE", "Deterministic, documented rules turn findings into a 0–100 threat score. Every point is traceable to a block and an explorer link."],
            ["SIMULATE", "BigInt AMM math stress-tests exits: whale dumps, LP pulls, active-range v3 depth."],
            ["RESCUE", "EIP-5792 wallet_sendCalls batches revokes + USDC unwind into one signature, simulated first."],
            ["PAGE", "Webhook / Telegram alerts carry /rescue deep links pre-loaded with the target."],
          ].map(([k, d], i) => (
            <li key={k} className="bg-surface p-5">
              <p className="mono text-[11px] text-ink-3">0{i + 1}</p>
              <p className="mt-2 mono text-[14px] text-phosphor">{k}</p>
              <p className="mt-2 text-[12px] leading-relaxed text-ink-3">{d}</p>
            </li>
          ))}
        </ol>
        <Link href="/how-it-works" className="mt-5 inline-block mono text-[12px] text-phosphor hover:underline">Read the architecture →</Link>
      </section>

      {/* ───────────── AGENTS + TOKEN ───────────── */}
      <section className="grid gap-6 pb-24 lg:grid-cols-[1.3fr_1fr]">
        <Panel title="For autonomous agents" n="07">
          <p className="text-[14px] text-ink-2">Trading agents call Kestrel before they swap. Free preview verdicts; full verdicts pay 0.01 USDC on Base via HTTP 402 (x402). Or mount it as an MCP server.</p>
          <pre className="mt-4 overflow-x-auto border hairline bg-canvas p-4 mono text-[12px] leading-relaxed text-ink-2">
{`$ curl "/api/v1/guard?address=${CONTRACTS.base.vibesToken}&chainId=8453"
{ "verdict": "ALLOW", "riskScore": ${scan?.score ?? 10}, "band": "${scan?.band ?? "NOMINAL"}", … }

$ curl -X POST /api/mcp -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
→ scan_contract · check_bridge_parity · simulate_exit · inspect_vibestarter_escrow`}
          </pre>
          <Link href="/agents" className="mt-4 inline-block mono text-[12px] text-phosphor hover:underline">Agent docs & live x402 playground →</Link>
        </Panel>
        <Panel title="$KEST utility" n="08">
          <ul className="space-y-3 text-[13px] text-ink-2">
            <li><span className="text-ink">Watcher slots</span> — stake for always-on sub-block monitoring of your wallets and escrows.</li>
            <li><span className="text-ink">Agent firewall credits</span> — prepay x402 guard calls at a discount.</li>
            <li><span className="text-ink">Panic Bunker policies</span> — pre-authorized rescue automation tiers.</li>
          </ul>
          <p className="mt-4 text-[12px] text-ink-3">Utility design only — no token is live. Read the risk disclosure.</p>
          <Link href="/token" className="mt-4 inline-block mono text-[12px] text-phosphor hover:underline">$KEST design →</Link>
        </Panel>
      </section>

      {/* ───────────── FINAL CTA ───────────── */}
      <section className="mb-8 border hairline bg-surface px-6 py-14 text-center">
        <p className="font-serif text-[40px] leading-tight text-ink">Hand Kestrel the night shift.</p>
        <p className="mt-3 text-[14px] text-ink-3">Paste any address. No signup, no wallet, no mock data.</p>
        <Link href="/app" className="mt-8 inline-flex items-center gap-2 rounded-[2px] bg-phosphor px-6 py-3 mono text-[13px] font-semibold text-canvas hover:bg-[#a6e698]">
          LAUNCH APP →
        </Link>
      </section>
    </div>
  );
}
