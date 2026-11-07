/**
 * Known EIP-7702 wallet delegators (pure, client-safe). Each entry was checked live on Base on 2026-11-07:
 * the address has code and answers with the identity noted below. Anything not listed is UNKNOWN —
 * unknown delegates get X-Rayed and keep their warning; they are never assumed safe.
 */
export interface Known7702Delegate {
  address: string;
  label: string;
  vendor: string;
  evidence: string;
}

export const KNOWN_7702_DELEGATES: readonly Known7702Delegate[] = [
  {
    address: "0x63c0c19a282a1B52b07dD5a65b58948A07DAE32B",
    label: "MetaMask EIP7702StatelessDeleGator",
    vendor: "MetaMask",
    evidence: "eip712Domain() name 'EIP7702StatelessDeleGator', NAME() same, VERSION() 1.3.0",
  },
  {
    address: "0x000000009B1D0aF20D8C6d0A44e162d11F9b8f00",
    label: "Uniswap Calibur",
    vendor: "Uniswap",
    evidence: "eip712Domain() name 'Calibur', version 1.0.0",
  },
  {
    address: "0x5A7FC11397E9a8AD41BF10bf13F22B0a63f96f6d",
    label: "Ambire AmbireAccount7702",
    vendor: "Ambire",
    evidence: "answers AmbireAccount privileges(address) (bytes32)",
  },
  {
    address: "0x4Cd241E8d1510e30b2076397afc7508Ae59C66c9",
    label: "eth-infinitism Simple7702Account",
    vendor: "ERC-4337 reference",
    evidence: "entryPoint() = EntryPoint v0.8 0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  },
];

export function known7702Delegate(address: string | null | undefined): Known7702Delegate | null {
  if (!address) return null;
  const a = address.toLowerCase();
  return KNOWN_7702_DELEGATES.find((d) => d.address.toLowerCase() === a) ?? null;
}
