import { type Address, getAddress } from "viem";
import { OWNABLE_ABI, SAFE_MULTISIG_ABI } from "@/lib/abis";
import { ACCESS_CONTROL_ENUMERABLE_ABI, DEFAULT_ADMIN_ROLE, IMPLEMENTATION_ABI } from "@/lib/abis/pools-extra";
import { type BytecodeInspection, inspectRawBytecode, parseAddressFromSlot, PROXY_STORAGE_SLOTS } from "@/lib/bytecode-signatures";
import { getPublicClientForChain } from "@/lib/rpc";
import { isContractAnswer, isRpcFailure } from "./call-errors";
import { errMsg } from "./chain-utils";
import { known7702Delegate } from "./eip7702";
import type { ChainId, ControllerPosture, ProxyKind, XrayReport } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

type Read<T> = { ok: true; value: T } | { ok: false; error: string; raw: unknown };

/** Separate "the RPC failed" from "the answer is empty" — failures must surface as UNKNOWN, never as clean. */
async function read<T>(p: Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await p };
  } catch (e) {
    return { ok: false, error: errMsg(e), raw: e };
  }
}

const isZeroish = (a: string | null | undefined) => !a || a.toLowerCase() === ZERO || a.toLowerCase() === DEAD;

/**
 * Classify a privileged address: renounced, EOA, EIP-7702 delegated EOA (known wallet delegator or not),
 * Safe multisig (m-of-n), or other contract. Non-Safe contracts are resolved one level deeper via their
 * own owner() (e.g. a ProxyAdmin → the EOA/Safe that owns it). RPC failures return kind "unknown".
 */
export async function classifyController(chainId: ChainId, role: string, addr: string | null, depth = 1): Promise<ControllerPosture> {
  if (isZeroish(addr)) return { role, address: addr, kind: "renounced" };
  const client = getPublicClientForChain(chainId);
  const address = getAddress(addr as string);
  const code = await read(client.getCode({ address }));
  if (!code.ok) return { role, address, kind: "unknown", label: "code unreadable (RPC error)" };
  const insp = inspectRawBytecode(code.value);
  if (insp.eip7702Delegate) {
    const known = known7702Delegate(insp.eip7702Delegate);
    return { role, address, kind: "eip7702", label: known ? `delegates to ${known.label}` : `delegates to unknown ${insp.eip7702Delegate}` };
  }
  if (!insp.isContract) return { role, address, kind: "eoa" };
  const safe = await read(
    client.multicall({
      allowFailure: true,
      contracts: [
        { address, abi: SAFE_MULTISIG_ABI, functionName: "getThreshold" },
        { address, abi: SAFE_MULTISIG_ABI, functionName: "getOwners" },
        { address, abi: OWNABLE_ABI, functionName: "owner" },
      ],
    })
  );
  if (!safe.ok) return { role, address, kind: "unknown", label: "Safe/owner probe failed (RPC error)" };
  const [threshold, owners, owner] = safe.value;
  if (isRpcFailure(threshold) || isRpcFailure(owners)) return { role, address, kind: "unknown", label: "Safe probe failed (RPC error)" };
  if (threshold.status === "success" && owners.status === "success") {
    return { role, address, kind: "safe", safeThreshold: Number(threshold.result), safeOwners: owners.result.length };
  }
  const out: ControllerPosture = { role, address, kind: "contract" };
  if (depth > 0 && owner.status === "success" && owner.result.toLowerCase() !== address.toLowerCase()) {
    out.resolvedOwner = await classifyController(chainId, `${role} → owner()`, owner.result, depth - 1);
  }
  return out;
}

/** Follow a non-Safe contract controller to the key that really decides (its owner()), if resolved. */
export function effectiveController(c: ControllerPosture): ControllerPosture {
  return c.kind === "contract" && c.resolvedOwner ? effectiveController(c.resolvedOwner) : c;
}

/**
 * Raw EVM X-Ray: eth_getCode + EIP-1967 implementation/admin/beacon slots + legacy ZeppelinOS slots
 * (+ beacon implementation() and EIP-897 fallback), a dispatcher-selector scan of the code that actually
 * executes (implementation, clone target or EIP-7702 delegate), owner()/admin()/DEFAULT_ADMIN_ROLE posture,
 * and the real upgrade authority (ProxyAdmin → its owner; UUPS → the implementation's owner/role).
 * Any RPC failure sets `degraded` (fail closed: UNKNOWN, never "clean").
 */
export async function xrayContract(chainId: ChainId, address: Address): Promise<XrayReport> {
  const client = getPublicClientForChain(chainId);
  const degradedReasons: string[] = [];
  const slot = (name: keyof typeof PROXY_STORAGE_SLOTS) => read(client.getStorageAt({ address, slot: PROXY_STORAGE_SLOTS[name] }));
  const [codeR, implR, adminR, beaconR, zImplR, zAdminR] = await Promise.all([
    read(client.getCode({ address })),
    slot("eip1967Implementation"),
    slot("eip1967Admin"),
    slot("eip1967Beacon"),
    slot("zeppelinosImplementation"),
    slot("zeppelinosAdmin"),
  ]);
  if (!codeR.ok) degradedReasons.push(`eth_getCode failed: ${codeR.error}`);
  const slotVal = (r: Read<string | undefined>, label: string) => {
    if (!r.ok) {
      degradedReasons.push(`${label} slot unreadable: ${r.error}`);
      return null;
    }
    return parseAddressFromSlot(r.value);
  };
  const top = inspectRawBytecode(codeR.ok ? codeR.value : undefined);
  const impl1967 = slotVal(implR, "EIP-1967 implementation");
  const admin1967 = slotVal(adminR, "EIP-1967 admin");
  const beacon = slotVal(beaconR, "EIP-1967 beacon");
  const zImpl = slotVal(zImplR, "ZeppelinOS implementation");
  const zAdmin = slotVal(zAdminR, "ZeppelinOS admin");
  const eip7702DelegateLabel = known7702Delegate(top.eip7702Delegate)?.label ?? null;

  // Resolve the logic that really runs
  let proxyKind: ProxyKind = top.eip1167CloneTarget ? "eip1167-clone" : "none";
  let implementation: string | null = null;
  let admin: string | null = null;
  if (top.isContract) {
    if (impl1967) {
      implementation = impl1967;
      admin = admin1967;
      proxyKind = admin1967 ? "eip1967-transparent" : "eip1967-uups";
    } else if (beacon) {
      proxyKind = "eip1967-beacon";
      const bi = await read(client.readContract({ address: getAddress(beacon), abi: IMPLEMENTATION_ABI, functionName: "implementation" }));
      if (bi.ok && !isZeroish(bi.value)) implementation = getAddress(bi.value);
      else degradedReasons.push(`beacon ${beacon} implementation() unreadable${bi.ok ? " (zero)" : `: ${bi.error}`}`);
    } else if (zImpl) {
      implementation = zImpl;
      admin = zAdmin;
      proxyKind = "zeppelinos-legacy";
    } else if (!top.eip1167CloneTarget && top.hasDelegatecall && top.byteSize > 0 && top.byteSize < 4096) {
      // EIP-897 forwarder with no standard slots: ask it. A revert simply means "not EIP-897".
      const r = await read(client.readContract({ address, abi: IMPLEMENTATION_ABI, functionName: "implementation" }));
      if (r.ok && !isZeroish(r.value) && r.value.toLowerCase() !== address.toLowerCase()) {
        implementation = getAddress(r.value);
        proxyKind = "eip897";
      } else if (!r.ok && !isContractAnswer(r.raw)) {
        degradedReasons.push(`EIP-897 implementation() probe failed: ${r.error}`);
      }
    }
  }

  // Analyze the logic that really runs (proxy implementation, clone target, or an EIP-7702 delegate)
  let analyzed: BytecodeInspection = top;
  let analyzedCodeAddress: string | null = top.isContract ? address : null;
  const logicAddr = implementation ?? top.eip1167CloneTarget ?? top.eip7702Delegate;
  if (logicAddr) {
    const logicR = await read(client.getCode({ address: getAddress(logicAddr) }));
    if (!logicR.ok) degradedReasons.push(`logic code at ${logicAddr} unreadable: ${logicR.error}`);
    const logic = inspectRawBytecode(logicR.ok ? logicR.value : undefined);
    if (logic.isContract) {
      analyzed = logic;
      analyzedCodeAddress = getAddress(logicAddr);
    } else if (logicR.ok && implementation) {
      degradedReasons.push(`implementation ${logicAddr} has no code`);
    }
  }

  // A small DELEGATECALL forwarder with no resolvable logic (Diamond, slot-0 singleton proxy, unknown clone): only
  // the forwarder's bytes were scanned, so "no privileged selectors" would be a false all-clear.
  const unresolvedDelegatecall = top.isContract && top.hasDelegatecall && proxyKind === "none" && !logicAddr && top.byteSize < 4096;

  const controllers: ControllerPosture[] = [];
  let upgradeAuthority: ControllerPosture | null = null;
  if (top.isContract) {
    const fns = await read(
      client.multicall({
        allowFailure: true,
        contracts: [
          { address, abi: OWNABLE_ABI, functionName: "owner" },
          { address, abi: OWNABLE_ABI, functionName: "admin" },
          { address, abi: ACCESS_CONTROL_ENUMERABLE_ABI, functionName: "getRoleMember", args: [DEFAULT_ADMIN_ROLE, 0n] },
        ],
      })
    );
    if (!fns.ok) degradedReasons.push(`owner()/admin() probe failed: ${fns.error}`);
    const [owner, adminFn, roleAdmin] = fns.ok ? fns.value : [null, null, null];
    if ([owner, adminFn, roleAdmin].some((r) => isRpcFailure(r))) degradedReasons.push("owner()/admin()/role probe hit an RPC error");

    const [ownerCtl, adminFnCtl, roleCtl] = await Promise.all([
      owner?.status === "success" ? classifyController(chainId, "owner()", owner.result) : null,
      adminFn?.status === "success" ? classifyController(chainId, "admin()", adminFn.result) : null,
      roleAdmin?.status === "success" ? classifyController(chainId, "DEFAULT_ADMIN_ROLE[0]", roleAdmin.result) : null,
    ]);
    for (const c of [ownerCtl, adminFnCtl, roleCtl]) if (c) controllers.push(c);

    const upgradeSelectors = analyzed.matchedSelectors.some((s) => s.capability === "upgrade");
    if (proxyKind === "eip1967-transparent" || proxyKind === "zeppelinos-legacy") {
      upgradeAuthority = await classifyController(chainId, proxyKind === "zeppelinos-legacy" ? "ZeppelinOS admin slot" : "EIP-1967 admin slot", admin);
    } else if (proxyKind === "eip1967-uups") {
      // UUPS: the empty admin slot is NOT renounced — upgradeTo is gated inside the implementation.
      upgradeAuthority = ownerCtl ?? roleCtl ?? adminFnCtl ?? null;
      if (!upgradeAuthority && upgradeSelectors) {
        upgradeAuthority = { role: "UUPS upgrade gate", address: null, kind: "unknown", label: "implementation exposes upgradeTo but no owner()/DEFAULT_ADMIN_ROLE holder is readable" };
      }
    } else if (proxyKind === "eip1967-beacon" && beacon) {
      const bo = await read(client.readContract({ address: getAddress(beacon), abi: OWNABLE_ABI, functionName: "owner" }));
      upgradeAuthority = bo.ok
        ? await classifyController(chainId, "beacon owner()", bo.value)
        : { role: "beacon owner()", address: null, kind: "unknown", label: `beacon ${beacon} has no readable owner()` };
    } else if (proxyKind === "eip897") {
      upgradeAuthority = adminFnCtl ?? ownerCtl ?? { role: "EIP-897 upgrade gate", address: null, kind: "unknown", label: "no admin()/owner() readable" };
    }

    // Surface the upgrade key (and the owner behind a ProxyAdmin / beacon) as their own rows for the UI.
    const rows: ControllerPosture[] = [];
    if (upgradeAuthority && !controllers.includes(upgradeAuthority)) rows.push(upgradeAuthority);
    for (const c of [...controllers, ...rows]) {
      let r = c.resolvedOwner;
      while (r) {
        rows.push(r);
        r = r.resolvedOwner;
      }
    }
    const seen = new Set(controllers.map((c) => c.role));
    for (const r of rows) if (!seen.has(r.role)) (seen.add(r.role), controllers.push(r));
  }

  return {
    chainId,
    address,
    isContract: top.isContract,
    byteSize: top.byteSize,
    eip7702Delegate: top.eip7702Delegate,
    eip7702DelegateLabel,
    eip1167CloneTarget: top.eip1167CloneTarget,
    implementation,
    admin,
    beacon,
    proxyKind,
    upgradeAuthority,
    analyzedCodeAddress,
    matchedSelectors: analyzed.matchedSelectors,
    hasSelfdestruct: analyzed.hasSelfdestruct,
    hasDelegatecall: top.hasDelegatecall || analyzed.hasDelegatecall,
    push4Count: analyzed.push4Count,
    controllers,
    ...(unresolvedDelegatecall ? { unresolvedDelegatecall: true } : {}),
    degraded: degradedReasons.length > 0,
    degradedReasons,
  };
}
