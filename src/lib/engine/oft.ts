import { type Address, decodeAbiParameters, type Hex, pad, type PublicClient } from "viem";
import { LAYERZERO, LZ_DVN_NAMES, type LzChainId } from "@/config/layerzero";
import { SAFE_MULTISIG_ABI } from "@/lib/abis";
import { LZ_DVN_FEE_ABI, LZ_ENDPOINT_V2_ABI, LZ_EXECUTOR_FEE_ABI, VIBES_OFT_ADAPTER_ABI } from "@/lib/abis/layerzero";
import { basePublicClient, robinhoodPublicClient, settle } from "@/lib/rpc";
import type { OftBridgeReport, OftGovernance, OftLane } from "./types";

const ZERO_HASH = `0x${"0".repeat(64)}`;
const NIL_PAYLOAD_HASH = `0x${"f".repeat(64)}`; // endpoint.nilify() marker
const QUOTE_TO = pad("0x000000000000000000000000000000000000dEaD", { size: 32 });
const QUOTE_AMOUNT = 1_000_000n * 10n ** 18n; // LZ fee is amount-independent (verified 1 → 50M VIBES)
const OFT_MESSAGE_BYTES = 40n; // bytes32 to + uint64 amountSD (no compose) → executor calldata size
const STUCK_SCAN = 32n; // most recent nonces checked for verified-but-unexecuted packets
const MSG_TYPE_SEND = 1;

const ULN_CONFIG = [
  {
    type: "tuple",
    components: [
      { name: "confirmations", type: "uint64" },
      { name: "requiredDVNCount", type: "uint8" },
      { name: "optionalDVNCount", type: "uint8" },
      { name: "optionalDVNThreshold", type: "uint8" },
      { name: "requiredDVNs", type: "address[]" },
      { name: "optionalDVNs", type: "address[]" },
    ],
  },
] as const;
const EXECUTOR_CONFIG = [{ type: "tuple", components: [{ name: "maxMessageSize", type: "uint32" }, { name: "executor", type: "address" }] }] as const;

const b32 = (a: Address): Hex => pad(a.toLowerCase() as Address, { size: 32 });
const ok = <T,>(r: { status: "success"; result: T } | { status: "failure"; error: Error }): T | null => (r.status === "success" ? r.result : null);
const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
const dvnName = (d: string) => LZ_DVN_NAMES[d.toLowerCase()] ?? null;

/** Executor-only part of type-3 options (worker id 1), without the 0x0003 header — what ULN302 hands to executor.getFee(). */
export function executorOptions(options: Hex): Hex {
  const h = options.slice(2);
  if (h.slice(0, 4) !== "0003") return "0x";
  let out = "";
  for (let i = 4; i + 6 <= h.length; ) {
    const size = parseInt(h.slice(i + 2, i + 6), 16);
    if (h.slice(i, i + 2) === "01") out += h.slice(i, i + 6 + size * 2);
    i += 6 + size * 2;
  }
  return `0x${out}`;
}

/** Sum of lzReceive gas in type-3 options (option type 1 under worker 1), as the executor sums them. */
export function lzReceiveGas(options: Hex): bigint | null {
  const h = options.slice(2);
  if (h.slice(0, 4) !== "0003") return null;
  let gas = 0n;
  let found = false;
  for (let i = 4; i + 6 <= h.length; ) {
    const size = parseInt(h.slice(i + 2, i + 6), 16);
    const body = h.slice(i + 6, i + 6 + size * 2);
    if (h.slice(i, i + 2) === "01" && body.slice(0, 2) === "01" && body.length >= 34) {
      gas += BigInt(`0x${body.slice(2, 34)}`);
      found = true;
    }
    i += 6 + size * 2;
  }
  return found ? gas : null;
}

interface Side {
  chainId: LzChainId;
  client: PublicClient;
  eid: number;
  adapter: Address;
  endpoint: Address;
  remoteEid: number;
  remoteAdapter: Address;
}

function side(chainId: LzChainId): Side {
  const remote: LzChainId = chainId === 8453 ? 4663 : 8453;
  return {
    chainId,
    client: chainId === 4663 ? robinhoodPublicClient : basePublicClient,
    eid: LAYERZERO.eid[chainId],
    adapter: LAYERZERO.vibesAdapter[chainId],
    endpoint: LAYERZERO.endpointV2[chainId],
    remoteEid: LAYERZERO.eid[remote],
    remoteAdapter: LAYERZERO.vibesAdapter[remote],
  };
}

type PinnedBlock = { number: bigint; timestamp: bigint };

/** Owner Safe posture + whether owner / pauser have code (Safe vs EOA). Best-effort: unreadable → nulls. */
async function readGovernance(s: Side, bn: bigint, owner: Address | null, pauser: Address | null, delegate: Address | null): Promise<OftGovernance> {
  const code = (a: Address | null) => (a ? settle(s.client.getCode({ address: a, blockNumber: bn })) : Promise.resolve(null));
  const [ownerCode, pauserCode] = await Promise.all([code(owner), code(pauser)]);
  const ownerIsContract = owner ? (ownerCode === null ? null : ownerCode !== undefined && ownerCode !== "0x") : null;
  let ownerSafe: OftGovernance["ownerSafe"] = null;
  if (owner && ownerIsContract) {
    const r = await settle(
      s.client.multicall({
        allowFailure: true,
        blockNumber: bn,
        contracts: [
          { address: owner, abi: SAFE_MULTISIG_ABI, functionName: "getOwners" },
          { address: owner, abi: SAFE_MULTISIG_ABI, functionName: "getThreshold" },
        ],
      }),
    );
    const owners = r ? ok(r[0]) : null;
    const threshold = r ? ok(r[1]) : null;
    if (owners && threshold !== null) ownerSafe = { threshold: Number(threshold), owners: owners.length };
  }
  return {
    owner,
    ownerSafe,
    ownerIsContract,
    pauser,
    pauserIsContract: pauser ? (pauserCode === null ? null : pauserCode !== undefined && pauserCode !== "0x") : null,
    delegate,
  };
}

/**
 * Live read of both $VIBES OFT lanes: LayerZero fee quote, credit budgets (rate limits), pause state,
 * peers, DVN config, nonce accounting, stuck-packet scan and governance posture.
 * 3–4 multicall rounds per chain, all pinned to one block per chain (pass `blocks` to share the parity read's blocks).
 */
export async function readOftBridge(opts: { blocks?: { base: PinnedBlock; robinhood: PinnedBlock } } = {}): Promise<OftBridgeReport> {
  const S = [side(8453), side(4663)] as const;
  const blocks: readonly [PinnedBlock, PinnedBlock] = opts.blocks
    ? [opts.blocks.base, opts.blocks.robinhood]
    : await Promise.all([S[0].client.getBlock({ blockTag: "latest" }), S[1].client.getBlock({ blockTag: "latest" })]);

  // Round 1 — adapter + endpoint state
  const r1 = await Promise.all(
    S.map((s, i) =>
      s.client.multicall({
        allowFailure: true,
        blockNumber: blocks[i].number,
        contracts: [
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "quoteSend", args: [{ dstEid: s.remoteEid, to: QUOTE_TO, amountLD: QUOTE_AMOUNT, minAmountLD: 0n, extraOptions: "0x", composeMsg: "0x", oftCmd: "0x" }, false] },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "creditBudget", args: [s.remoteEid] },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "rateLimits", args: [s.remoteEid] },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "peers", args: [s.remoteEid] },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "enforcedOptions", args: [s.remoteEid, MSG_TYPE_SEND] },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "paused" },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "owner" },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "pauser" },
          { address: s.adapter, abi: VIBES_OFT_ADAPTER_ABI, functionName: "decimalConversionRate" },
          { address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "getSendLibrary", args: [s.adapter, s.remoteEid] },
          { address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "getReceiveLibrary", args: [s.adapter, s.remoteEid] },
          { address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "delegates", args: [s.adapter] },
          { address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "outboundNonce", args: [s.adapter, s.remoteEid, b32(s.remoteAdapter)] },
          { address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "inboundNonce", args: [s.adapter, s.remoteEid, b32(s.remoteAdapter)] },
          { address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "lazyInboundNonce", args: [s.adapter, s.remoteEid, b32(s.remoteAdapter)] },
        ],
      }),
    ),
  );

  const st = S.map((_, i) => {
    const [quote, credit, rl, peer, enforced, paused, owner, pauser, dust, sendLib, recvLib, delegate, outN, inN, lazyN] = r1[i];
    return {
      quote: ok(quote), credit: ok(credit), rl: ok(rl), peer: ok(peer), enforced: ok(enforced), paused: ok(paused),
      owner: ok(owner), pauser: ok(pauser), dust: ok(dust), sendLib: ok(sendLib), recvLib: ok(recvLib)?.[0] ?? null,
      delegate: ok(delegate), outN: ok(outN), inN: ok(inN), lazyN: ok(lazyN),
    };
  });
  if (st.every((x) => x.quote === null && x.credit === null && x.peer === null)) throw new Error("OFT adapter reads failed on both chains");

  // Round 2 — ULN/executor config + stuck-packet scan (needs the REMOTE outbound nonce) + governance posture
  const [r2, governance] = await Promise.all([
    Promise.all(
      S.map(async (s, i) => {
        const me = st[i];
        const remoteOut = st[1 - i].outN ?? 0n;
        const from = remoteOut > STUCK_SCAN ? remoteOut - STUCK_SCAN + 1n : 1n;
        const nonces: bigint[] = [];
        for (let n = from; n <= remoteOut; n++) nonces.push(n);
        const bn = blocks[i].number;
        const [execCfg, sendUln, recvUln, hashes] = await Promise.all([
          me.sendLib ? settle(s.client.readContract({ address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "getConfig", args: [s.adapter, me.sendLib, s.remoteEid, 1], blockNumber: bn })) : null,
          me.sendLib ? settle(s.client.readContract({ address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "getConfig", args: [s.adapter, me.sendLib, s.remoteEid, 2], blockNumber: bn })) : null,
          me.recvLib ? settle(s.client.readContract({ address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "getConfig", args: [s.adapter, me.recvLib, s.remoteEid, 2], blockNumber: bn })) : null,
          nonces.length
            ? settle(
                s.client.multicall({
                  allowFailure: true,
                  blockNumber: bn,
                  contracts: nonces.map((n) => ({ address: s.endpoint, abi: LZ_ENDPOINT_V2_ABI, functionName: "inboundPayloadHash" as const, args: [s.adapter, s.remoteEid, b32(s.remoteAdapter), n] as const })),
                }),
              )
            : Promise.resolve([]),
        ]);
        const decode = <T,>(f: () => T): T | null => {
          try {
            return f();
          } catch {
            return null;
          }
        };
        const exec = execCfg ? decode(() => decodeAbiParameters(EXECUTOR_CONFIG, execCfg)[0]) : null;
        const sendCfg = sendUln ? decode(() => decodeAbiParameters(ULN_CONFIG, sendUln)[0]) : null;
        const recvCfg = recvUln ? decode(() => decodeAbiParameters(ULN_CONFIG, recvUln)[0]) : null;
        const awaiting = (hashes ?? [])
          .map((h, k) => ({ nonce: nonces[k], hash: h.status === "success" ? (h.result as Hex) : null }))
          .filter((x) => x.hash && x.hash !== ZERO_HASH && x.hash.toLowerCase() !== NIL_PAYLOAD_HASH)
          .map((x) => ({ nonce: x.nonce.toString(), payloadHash: x.hash as string }));
        return { exec, sendCfg, recvCfg, awaiting };
      }),
    ),
    Promise.all(S.map((s, i) => readGovernance(s, blocks[i].number, st[i].owner, st[i].pauser, st[i].delegate))),
  ]);

  // Round 3 — optional fee breakdown (executor + each required/optional DVN); treasury = remainder
  const fees = await Promise.all(
    S.map(async (s, i) => {
      const cfg = r2[i].sendCfg;
      const exec = r2[i].exec;
      const enforced = st[i].enforced;
      const quote = st[i].quote;
      if (!cfg || !exec || !enforced || !quote) return null;
      const bn = blocks[i].number;
      const dvns = [...cfg.requiredDVNs, ...cfg.optionalDVNs];
      const [execFee, ...dvnFees] = await Promise.all([
        settle(s.client.readContract({ address: exec.executor, abi: LZ_EXECUTOR_FEE_ABI, functionName: "getFee", args: [s.remoteEid, s.adapter, OFT_MESSAGE_BYTES, executorOptions(enforced)], blockNumber: bn })),
        ...dvns.map((d) => settle(s.client.readContract({ address: d, abi: LZ_DVN_FEE_ABI, functionName: "getFee", args: [s.remoteEid, cfg.confirmations, s.adapter, "0x"], blockNumber: bn }))),
      ]);
      if (execFee === null || dvnFees.some((f) => f === null)) return null;
      const dvnSum = dvnFees.reduce<bigint>((a, f) => a + (f ?? 0n), 0n);
      const total = quote.nativeFee;
      const treasury = total > execFee + dvnSum ? total - execFee - dvnSum : 0n;
      return {
        executorWei: execFee.toString(),
        dvns: dvns.map((d, k) => ({ address: d, name: dvnName(d), feeWei: (dvnFees[k] ?? 0n).toString() })),
        treasuryWei: treasury.toString(),
      };
    }),
  );

  const lanes: OftLane[] = S.map((src, i) => {
    const j = 1 - i;
    const dst = S[j];
    const a = st[i];
    const b = st[j];
    const rl = b.rl; // destination's limiter keyed by the source eid
    const cb = b.credit;
    const limit = rl ? rl[2] : 0n;
    const windowSec = rl ? rl[3] : 0n;
    const inFlight = cb ? cb[0] : 0n;
    const sendCfg = r2[i].sendCfg;
    const recvCfg = r2[j].recvCfg;
    // Missing nonces are UNKNOWN — never 0 (that turned a failed read into the lane's whole history "in flight").
    const noncesKnown = a.outN !== null && b.inN !== null;
    const outbound = a.outN ?? 0n;
    const inbound = b.inN ?? 0n;
    return {
      direction: src.chainId === 8453 ? "base->robinhood" : "robinhood->base",
      srcChainId: src.chainId,
      dstChainId: dst.chainId,
      srcEid: src.eid,
      dstEid: dst.eid,
      srcAdapter: src.adapter,
      dstAdapter: dst.adapter,
      // A failed peers() read is UNKNOWN (null), never a mismatch.
      peersOk: a.peer == null || b.peer == null ? null : a.peer.toLowerCase() === b32(dst.adapter) && b.peer.toLowerCase() === b32(src.adapter),
      nativeFeeWei: (a.quote?.nativeFee ?? 0n).toString(),
      feeBreakdown: fees[i],
      enforcedLzReceiveGas: a.enforced ? (lzReceiveGas(a.enforced)?.toString() ?? null) : null,
      credit:
        rl && cb
          ? {
              limit: limit.toString(),
              windowSec: Number(windowSec),
              inFlight: inFlight.toString(),
              headroom: cb[1].toString(),
              refillPerSec: windowSec > 0n ? (limit / windowSec).toString() : "0",
              lastCreditAt: rl[1] > 0n ? Number(rl[1]) : null,
              secondsToFull: limit > 0n && windowSec > 0n ? Number(ceilDiv(inFlight * windowSec, limit)) : null,
            }
          : null,
      srcPaused: a.paused,
      dstPaused: b.paused,
      confirmations: sendCfg ? Number(sendCfg.confirmations) : null,
      requiredDvns: (sendCfg?.requiredDVNs ?? []).map((d) => ({ address: d, name: dvnName(d) })),
      optionalDvns: (sendCfg?.optionalDVNs ?? []).map((d) => ({ address: d, name: dvnName(d) })),
      optionalDvnThreshold: sendCfg ? sendCfg.optionalDVNThreshold : null,
      configMatches:
        sendCfg && recvCfg
          ? sendCfg.confirmations === recvCfg.confirmations &&
            sendCfg.requiredDVNCount === recvCfg.requiredDVNCount &&
            sendCfg.optionalDVNThreshold === recvCfg.optionalDVNThreshold // DVN addresses differ per chain by design; compare counts only
          : null,
      nonces: {
        outbound: a.outN !== null ? a.outN.toString() : "unknown",
        inboundVerified: b.inN !== null ? b.inN.toString() : "unknown",
        lazyExecuted: b.lazyN !== null ? b.lazyN.toString() : "unknown",
        unverified: noncesKnown && outbound > inbound ? Number(outbound - inbound) : 0,
        known: noncesKnown,
        awaitingExecution: r2[j].awaiting,
      },
    };
  });

  const ref = (i: 0 | 1) => ({ chainId: S[i].chainId, number: blocks[i].number.toString(), timestamp: Number(blocks[i].timestamp) });
  return {
    lanes,
    dustUnit: (st[0].dust ?? st[1].dust ?? 10n ** 12n).toString(),
    owner: { 8453: st[0].owner, 4663: st[1].owner },
    pauser: { 8453: st[0].pauser, 4663: st[1].pauser },
    delegate: { 8453: st[0].delegate, 4663: st[1].delegate },
    governance: { 8453: governance[0], 4663: governance[1] },
    blocks: { base: ref(0), robinhood: ref(1) },
    fetchedAt: new Date().toISOString(),
  };
}
