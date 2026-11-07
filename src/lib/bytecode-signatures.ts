import { type Hex, toFunctionSelector } from "viem";

/**
 * Standard Proxy Storage Slots (EIP-1967) for `eth_getStorageAt` X-Ray
 */
export const PROXY_STORAGE_SLOTS = {
  // bytes32(uint256(keccak256('eip1967.proxy.implementation')) - 1)
  eip1967Implementation:
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex,
  // bytes32(uint256(keccak256('eip1967.proxy.admin')) - 1)
  eip1967Admin:
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex,
  // bytes32(uint256(keccak256('eip1967.proxy.beacon')) - 1)
  eip1967Beacon:
    "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex,
} as const;

export type SignatureSeverity = "info" | "warn" | "high";

export interface BytecodeRiskSignature {
  selector: string; // lowercase 8-hex without 0x
  signature: string;
  severity: SignatureSeverity;
  label: string;
  explanation: string;
}

type SigDef = Omit<BytecodeRiskSignature, "selector">;

/** Selectors are derived from their canonical signatures at module load (keccak256), never hand-typed. */
const SIGNATURE_DEFS: SigDef[] = [
  { signature: "mint(address,uint256)", severity: "high", label: "Mint Capability", explanation: "Privileged mint(address,uint256) present — supply can be inflated unless the caller role is renounced or capped." },
  { signature: "burn(address,uint256)", severity: "high", label: "Holder Burn", explanation: "burn(address,uint256) can destroy tokens from an arbitrary holder if access-controlled by an owner." },
  { signature: "pause()", severity: "warn", label: "Pausable Transfers", explanation: "pause() can halt all transfers — exits freeze while paused." },
  { signature: "blacklist(address)", severity: "high", label: "Address Blacklist", explanation: "blacklist(address) can freeze individual holders." },
  { signature: "addToBlacklist(address)", severity: "high", label: "Address Blacklist", explanation: "addToBlacklist(address) can block wallets from transferring." },
  { signature: "setBlacklist(address,bool)", severity: "high", label: "Address Blacklist", explanation: "setBlacklist(address,bool) can toggle per-wallet transfer bans." },
  { signature: "isBlacklisted(address)", severity: "warn", label: "Blacklist Registry", explanation: "Contract maintains an address restriction mapping." },
  { signature: "setTax(uint256)", severity: "high", label: "Mutable Tax", explanation: "setTax(uint256) lets an owner raise transfer tax — a classic soft-rug vector." },
  { signature: "setTaxes(uint256,uint256)", severity: "high", label: "Mutable Buy/Sell Tax", explanation: "Owner can change buy/sell taxes after launch." },
  { signature: "setFee(uint256)", severity: "warn", label: "Mutable Fee", explanation: "setFee(uint256) allows fee changes by a privileged caller." },
  { signature: "setFees(uint256,uint256)", severity: "warn", label: "Mutable Fees", explanation: "setFees(uint256,uint256) allows fee changes by a privileged caller." },
  { signature: "setMaxTxAmount(uint256)", severity: "warn", label: "Max-Tx Limiter", explanation: "Owner can cap transaction size, which can block sells." },
  { signature: "excludeFromFee(address)", severity: "info", label: "Fee Exemptions", explanation: "Privileged addresses can be exempted from fees." },
  { signature: "renounceOwnership()", severity: "info", label: "Ownable Pattern", explanation: "OpenZeppelin Ownable present — current owner() decides real risk." },
  { signature: "upgradeTo(address)", severity: "high", label: "UUPS Upgradeable", explanation: "Logic can be swapped if the upgrade key is not behind a timelock or multisig." },
  { signature: "upgradeToAndCall(address,bytes)", severity: "high", label: "Upgradeable Logic", explanation: "Supports arbitrary implementation upgrades with an initialization call." },
];

export const RISKY_SELECTORS: BytecodeRiskSignature[] = SIGNATURE_DEFS.map((d) => ({
  ...d,
  selector: toFunctionSelector(`function ${d.signature}`).slice(2).toLowerCase(),
}));

export interface BytecodeInspection {
  isContract: boolean;
  byteSize: number;
  eip1167CloneTarget: string | null;
  eip7702Delegate: string | null;
  matchedSelectors: BytecodeRiskSignature[];
  hasSelfdestruct: boolean;
  hasDelegatecall: boolean;
  push4Count: number;
}

/** Strip the trailing Solidity CBOR metadata (last 2 bytes encode its length). */
function stripMetadata(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 4) return bytes;
  const len = (bytes[bytes.length - 2] << 8) | bytes[bytes.length - 1];
  if (len > 0 && len + 2 < bytes.length && bytes[bytes.length - 2 - len] === 0xa2) {
    return bytes.subarray(0, bytes.length - 2 - len);
  }
  return bytes;
}

function hexToBytes(clean: string): Uint8Array {
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
  return out;
}

/**
 * Walks raw EVM bytecode opcode-by-opcode (skipping PUSH immediates) so that:
 *  - 4-byte selectors are matched only when they are genuine PUSH4 operands
 *  - SELFDESTRUCT (0xff) / DELEGATECALL (0xf4) are matched only as real opcodes
 * Also detects EIP-1167 minimal proxies and EIP-7702 delegated EOAs.
 */
export function inspectRawBytecode(bytecodeHex: string | undefined | null): BytecodeInspection {
  const clean = (bytecodeHex ?? "").toLowerCase().replace(/^0x/, "");
  const empty: BytecodeInspection = {
    isContract: false,
    byteSize: 0,
    eip1167CloneTarget: null,
    eip7702Delegate: null,
    matchedSelectors: [],
    hasSelfdestruct: false,
    hasDelegatecall: false,
    push4Count: 0,
  };
  if (!clean) return empty;

  // EIP-7702: 0xef0100 || address (23 bytes) — an EOA with delegated code
  if (clean.length === 46 && clean.startsWith("ef0100")) {
    return { ...empty, byteSize: 23, eip7702Delegate: `0x${clean.slice(6)}` };
  }

  const cloneMatch = clean.match(/^363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
  const eip1167CloneTarget = cloneMatch ? `0x${cloneMatch[1]}` : null;

  const bytes = stripMetadata(hexToBytes(clean));
  const push4 = new Set<string>();
  let hasSelfdestruct = false;
  let hasDelegatecall = false;
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (op === 0x63 && i + 4 < bytes.length + 1) {
        let sel = "";
        for (let k = 1; k <= 4; k++) sel += (bytes[i + k] ?? 0).toString(16).padStart(2, "0");
        push4.add(sel);
      }
      i += n;
      continue;
    }
    if (op === 0xff) hasSelfdestruct = true;
    if (op === 0xf4) hasDelegatecall = true;
  }

  return {
    isContract: true,
    byteSize: clean.length / 2,
    eip1167CloneTarget,
    eip7702Delegate: null,
    matchedSelectors: RISKY_SELECTORS.filter((s) => push4.has(s.selector)),
    hasSelfdestruct,
    hasDelegatecall,
    push4Count: push4.size,
  };
}

/** Extract a 20-byte address from a 32-byte storage slot value returned by `eth_getStorageAt`. */
export function parseAddressFromSlot(slotHex: string | undefined | null): string | null {
  if (!slotHex) return null;
  const clean = slotHex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
  const addrHex = clean.slice(24);
  if (/^0+$/.test(addrHex)) return null;
  return `0x${addrHex}`;
}
