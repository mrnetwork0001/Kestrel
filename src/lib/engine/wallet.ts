import { type Address, getAddress } from "viem";
import { CONTRACTS, SPENDERS, TRACKED_TOKENS } from "@/config/contracts";
import { ERC20_ABI, PERMIT2_ABI } from "@/lib/abis";
import { inspectRawBytecode } from "@/lib/bytecode-signatures";
import { isUnlimited } from "@/lib/format";
import { getLogsClientForChain, getPublicClientForChain } from "@/lib/rpc";
import { blockHoursAgo, readTokenMeta } from "./chain-utils";
import { OVERNIGHT_HOURS } from "./pools";
import type { ApprovalExposure, ChainId, TokenMeta, WalletReport } from "./types";

const APPROVAL_EVENT = ERC20_ABI.find((x) => x.type === "event" && x.name === "Approval") as Extract<(typeof ERC20_ABI)[number], { type: "event"; name: "Approval" }>;

/**
 * Live wallet exposure scan:
 *  - native + tracked ERC-20 balances
 *  - ERC-20 allowance() to every known spender on the chain
 *  - Permit2 allowance(user, token, spender) sub-approvals (amount + expiry)
 *  - Approval(owner=wallet) event logs over the last 8h → discovers NEW spenders granted overnight
 */
export async function scanWallet(chainId: ChainId, address: Address, extraTokens: Address[] = []): Promise<WalletReport> {
  const client = getPublicClientForChain(chainId);
  const latest = await client.getBlock({ blockTag: "latest" });
  const [nativeBalance, code] = await Promise.all([
    client.getBalance({ address, blockNumber: latest.number }),
    client.getCode({ address }).catch(() => undefined),
  ]);
  const insp = inspectRawBytecode(code);

  // Overnight approval discovery (best effort — depends on RPC log range limits)
  const discovered: { token: Address; spender: Address }[] = [];
  let overnightApprovalScan: WalletReport["overnightApprovalScan"] = { available: false, hours: OVERNIGHT_HOURS, newApprovals: 0, note: "" };
  try {
    const fromBlock = await blockHoursAgo(chainId, client, latest.number, OVERNIGHT_HOURS);
    const logs = await getLogsClientForChain(chainId).getLogs({ event: APPROVAL_EVENT, args: { owner: address }, fromBlock, toBlock: latest.number });
    for (const l of logs) {
      if (l.args.spender) discovered.push({ token: getAddress(l.address), spender: getAddress(l.args.spender) });
    }
    overnightApprovalScan = { available: true, hours: OVERNIGHT_HOURS, newApprovals: logs.length, note: `Approval(owner) logs scanned from block #${fromBlock}.` };
  } catch {
    overnightApprovalScan.note = "Public RPC rejected the cross-token Approval log query; known-spender scan still applies.";
  }

  const tokenSet = new Map<string, Address>();
  for (const t of [...TRACKED_TOKENS[chainId], ...extraTokens, ...discovered.map((d) => d.token)]) tokenSet.set(t.toLowerCase(), t);
  const tokens = [...tokenSet.values()].slice(0, 24);
  const metas = (await Promise.all(tokens.map((t) => readTokenMeta(chainId, t).catch(() => null)))).filter((m): m is TokenMeta => m !== null);

  const spenderMap = new Map<string, { name: string; address: Address }>();
  for (const s of SPENDERS[chainId]) spenderMap.set(s.address.toLowerCase(), s);
  for (const d of discovered) if (!spenderMap.has(d.spender.toLowerCase())) spenderMap.set(d.spender.toLowerCase(), { name: "Unlabeled spender (granted overnight)", address: d.spender });
  const spenders = [...spenderMap.values()];

  const permit2Live = chainId === 8453 || (await client.getCode({ address: CONTRACTS.base.permit2 }).then((c) => !!c && c !== "0x").catch(() => false));
  const permit2Spenders = spenders.filter((s) => s.address.toLowerCase() !== CONTRACTS.base.permit2.toLowerCase());

  const balanceCalls = metas.map((m) => ({ address: m.address as Address, abi: ERC20_ABI, functionName: "balanceOf" as const, args: [address] as const }));
  const allowanceCalls = metas.flatMap((m) => spenders.map((s) => ({ address: m.address as Address, abi: ERC20_ABI, functionName: "allowance" as const, args: [address, s.address] as const })));
  const permitCalls = permit2Live
    ? metas.flatMap((m) => permit2Spenders.map((s) => ({ address: CONTRACTS.base.permit2, abi: PERMIT2_ABI, functionName: "allowance" as const, args: [address, m.address as Address, s.address] as const })))
    : [];

  const [balRes, allowRes, permitRes] = await Promise.all([
    client.multicall({ allowFailure: true, blockNumber: latest.number, contracts: balanceCalls }),
    client.multicall({ allowFailure: true, blockNumber: latest.number, contracts: allowanceCalls }),
    permitCalls.length ? client.multicall({ allowFailure: true, blockNumber: latest.number, contracts: permitCalls }) : Promise.resolve([]),
  ]);

  const discoveredKey = new Set(discovered.map((d) => `${d.token.toLowerCase()}:${d.spender.toLowerCase()}`));
  const approvals: ApprovalExposure[] = [];
  metas.forEach((m, ti) => {
    spenders.forEach((s, si) => {
      const r = allowRes[ti * spenders.length + si];
      if (r?.status === "success" && (r.result as bigint) > 0n) {
        const amt = r.result as bigint;
        approvals.push({
          token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: s.address, spenderName: s.name,
          kind: "erc20", amount: amt.toString(), unlimited: isUnlimited(amt),
          discoveredOvernight: discoveredKey.has(`${m.address.toLowerCase()}:${s.address.toLowerCase()}`),
        });
      }
    });
  });
  const nowSec = Number(latest.timestamp);
  if (permit2Live) {
    metas.forEach((m, ti) => {
      permit2Spenders.forEach((s, si) => {
        const r = permitRes[ti * permit2Spenders.length + si];
        if (r?.status === "success") {
          const [amount, expiration] = r.result as readonly [bigint, number, number];
          if (amount > 0n && Number(expiration) > nowSec) {
            approvals.push({
              token: m.address, tokenSymbol: m.symbol, tokenDecimals: m.decimals, spender: s.address, spenderName: `${s.name} via Permit2`,
              kind: "permit2", amount: amount.toString(), unlimited: isUnlimited(amount), expiration: Number(expiration), discoveredOvernight: false,
            });
          }
        }
      });
    });
  }

  return {
    chainId,
    address,
    nativeBalance: nativeBalance.toString(),
    eip7702Delegate: insp.eip7702Delegate,
    holdings: metas
      .map((m, i) => ({ token: m.address, symbol: m.symbol, decimals: m.decimals, balance: balRes[i]?.status === "success" ? (balRes[i].result as bigint).toString() : "0" }))
      .filter((h) => h.balance !== "0"),
    approvals,
    spendersChecked: spenders.length,
    overnightApprovalScan,
  };
}
