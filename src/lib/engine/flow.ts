import { type Address, getAddress } from "viem";
import { KNOWN_LABELS } from "@/config/contracts";
import { ERC20_ABI } from "@/lib/abis";
import { getLogsClientForChain, getPublicClientForChain } from "@/lib/rpc";
import { blockHoursAgo } from "./chain-utils";
import { OVERNIGHT_HOURS } from "./pools";
import type { ChainId, OvernightTokenFlow, TokenMeta } from "./types";

const TRANSFER_EVENT = ERC20_ABI.find((x) => x.type === "event" && x.name === "Transfer") as Extract<(typeof ERC20_ABI)[number], { type: "event"; name: "Transfer" }>;
const MAX_LOGS = 5_000;

/**
 * Overnight token flow from live Transfer logs (no indexer):
 * transfer count, volume, largest single transfer, and the largest current holder among
 * overnight-active wallets (excluding pools/bridges/escrows) — used as the "whale" in Chaos Lab.
 */
export async function readOvernightFlow(chainId: ChainId, token: TokenMeta, exclude: string[] = []): Promise<OvernightTokenFlow> {
  const client = getPublicClientForChain(chainId);
  const empty: OvernightTokenFlow = {
    available: false, hours: OVERNIGHT_HOURS, fromBlock: null, transferCount: 0, volume: "0", largestTransfer: "0", largestTransferTx: null, topHolder: null, note: "",
  };
  try {
    const latest = await client.getBlockNumber();
    const fromBlock = await blockHoursAgo(chainId, client, latest, OVERNIGHT_HOURS);
    const logs = await getLogsClientForChain(chainId).getLogs({ address: token.address as Address, event: TRANSFER_EVENT, fromBlock, toBlock: latest });
    const capped = logs.slice(-MAX_LOGS);
    let volume = 0n;
    let largest = 0n;
    let largestTx: string | null = null;
    const touched = new Map<string, bigint>();
    const skip = new Set([...Object.keys(KNOWN_LABELS), ...exclude.map((e) => e.toLowerCase())]);
    for (const l of capped) {
      const v = l.args.value ?? 0n;
      volume += v;
      if (v > largest) {
        largest = v;
        largestTx = l.transactionHash;
      }
      for (const a of [l.args.from, l.args.to]) {
        if (!a) continue;
        const k = a.toLowerCase();
        if (skip.has(k)) continue;
        touched.set(k, (touched.get(k) ?? 0n) + v);
      }
    }
    // Check current balances of the 12 most active counterparties
    const candidates = [...touched.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 12).map(([a]) => getAddress(a));
    let topHolder: OvernightTokenFlow["topHolder"] = null;
    if (candidates.length) {
      const bals = await client.multicall({
        allowFailure: true,
        contracts: candidates.map((a) => ({ address: token.address as Address, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [a] as const })),
      });
      let best = -1;
      let bestBal = 0n;
      bals.forEach((b, i) => {
        if (b.status === "success" && (b.result as bigint) > bestBal) {
          bestBal = b.result as bigint;
          best = i;
        }
      });
      if (best >= 0) {
        const code = await client.getCode({ address: candidates[best] }).catch(() => undefined);
        const supply = BigInt(token.totalSupply);
        topHolder = {
          address: candidates[best],
          balance: bestBal.toString(),
          shareBps: supply > 0n ? Number((bestBal * 10_000n) / supply) : 0,
          isContract: !!code && code !== "0x" && !code.startsWith("0xef0100"),
        };
      }
    }
    return {
      available: true,
      hours: OVERNIGHT_HOURS,
      fromBlock: fromBlock.toString(),
      transferCount: logs.length,
      volume: volume.toString(),
      largestTransfer: largest.toString(),
      largestTransferTx: largestTx,
      topHolder,
      note: logs.length > MAX_LOGS ? `Analyzed the latest ${MAX_LOGS} of ${logs.length} transfers.` : `Transfer logs since block #${fromBlock}.`,
    };
  } catch {
    return { ...empty, note: "Public RPC rejected the overnight Transfer log range for this token (likely too many events)." };
  }
}
