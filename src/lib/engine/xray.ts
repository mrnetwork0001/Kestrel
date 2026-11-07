import { type Address, getAddress } from "viem";
import { OWNABLE_ABI, SAFE_MULTISIG_ABI } from "@/lib/abis";
import { inspectRawBytecode, parseAddressFromSlot, PROXY_STORAGE_SLOTS } from "@/lib/bytecode-signatures";
import { getPublicClientForChain } from "@/lib/rpc";
import type { ChainId, ControllerPosture, XrayReport } from "./types";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";

/** Classify a privileged address: renounced, EOA, EIP-7702 delegated EOA, Safe multisig (m-of-n), or other contract. */
export async function classifyController(chainId: ChainId, role: string, addr: string | null): Promise<ControllerPosture> {
  if (!addr || addr.toLowerCase() === ZERO || addr.toLowerCase() === DEAD) {
    return { role, address: addr, kind: "renounced" };
  }
  const client = getPublicClientForChain(chainId);
  const address = getAddress(addr);
  const code = await client.getCode({ address }).catch(() => undefined);
  const insp = inspectRawBytecode(code);
  if (insp.eip7702Delegate) return { role, address, kind: "eip7702" };
  if (!insp.isContract) return { role, address, kind: "eoa" };
  const [threshold, owners] = await client.multicall({
    allowFailure: true,
    contracts: [
      { address, abi: SAFE_MULTISIG_ABI, functionName: "getThreshold" },
      { address, abi: SAFE_MULTISIG_ABI, functionName: "getOwners" },
    ],
  });
  if (threshold.status === "success" && owners.status === "success") {
    return { role, address, kind: "safe", safeThreshold: Number(threshold.result), safeOwners: owners.result.length };
  }
  return { role, address, kind: "contract" };
}

/**
 * Raw EVM X-Ray: eth_getCode + EIP-1967 implementation/admin/beacon slots, selector scan of the
 * code that actually executes (implementation or EIP-1167 clone target), and owner()/admin posture.
 */
export async function xrayContract(chainId: ChainId, address: Address): Promise<XrayReport> {
  const client = getPublicClientForChain(chainId);
  const [code, implSlot, adminSlot, beaconSlot] = await Promise.all([
    client.getCode({ address }).catch(() => undefined),
    client.getStorageAt({ address, slot: PROXY_STORAGE_SLOTS.eip1967Implementation }).catch(() => undefined),
    client.getStorageAt({ address, slot: PROXY_STORAGE_SLOTS.eip1967Admin }).catch(() => undefined),
    client.getStorageAt({ address, slot: PROXY_STORAGE_SLOTS.eip1967Beacon }).catch(() => undefined),
  ]);
  const top = inspectRawBytecode(code);
  const implementation = parseAddressFromSlot(implSlot);
  const admin = parseAddressFromSlot(adminSlot);
  const beacon = parseAddressFromSlot(beaconSlot);

  // Analyze the logic that really runs
  let analyzed = top;
  let analyzedCodeAddress: string | null = top.isContract ? address : null;
  const logicAddr = implementation ?? top.eip1167CloneTarget;
  if (logicAddr) {
    const logicCode = await client.getCode({ address: getAddress(logicAddr) }).catch(() => undefined);
    const logic = inspectRawBytecode(logicCode);
    if (logic.isContract) {
      analyzed = logic;
      analyzedCodeAddress = getAddress(logicAddr);
    }
  }

  const controllers: ControllerPosture[] = [];
  if (top.isContract) {
    const [owner, adminFn] = await client.multicall({
      allowFailure: true,
      contracts: [
        { address, abi: OWNABLE_ABI, functionName: "owner" },
        { address, abi: OWNABLE_ABI, functionName: "admin" },
      ],
    });
    const tasks: Promise<ControllerPosture>[] = [];
    if (owner.status === "success") tasks.push(classifyController(chainId, "owner()", owner.result));
    if (adminFn.status === "success") tasks.push(classifyController(chainId, "admin()", adminFn.result));
    if (implementation) tasks.push(classifyController(chainId, "EIP-1967 admin slot", admin));
    controllers.push(...(await Promise.all(tasks)));
  }

  return {
    chainId,
    address,
    isContract: top.isContract,
    byteSize: top.byteSize,
    eip7702Delegate: top.eip7702Delegate,
    eip1167CloneTarget: top.eip1167CloneTarget,
    implementation,
    admin,
    beacon,
    analyzedCodeAddress,
    matchedSelectors: analyzed.matchedSelectors,
    hasSelfdestruct: analyzed.hasSelfdestruct,
    hasDelegatecall: top.hasDelegatecall || analyzed.hasDelegatecall,
    push4Count: analyzed.push4Count,
    controllers,
  };
}
