import { formatUnits } from "viem";

export const EXPLORERS: Record<number, string> = {
  8453: "https://basescan.org",
  4663: "https://robinhoodchain.blockscout.com",
};

export function chainName(chainId: number): string {
  return chainId === 4663 ? "Robinhood Chain" : "Base";
}

export function chainShort(chainId: number): string {
  return chainId === 4663 ? "RH" : "BASE";
}

export function explorerAddress(chainId: number, address: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[8453]}/address/${address}`;
}

export function explorerTx(chainId: number, hash: string): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[8453]}/tx/${hash}`;
}

export function explorerBlock(chainId: number, block: string | number | bigint): string {
  return `${EXPLORERS[chainId] ?? EXPLORERS[8453]}/block/${block.toString()}`;
}

export function shortAddr(addr: string | null | undefined, n = 4): string {
  if (!addr) return "—";
  return `${addr.slice(0, 2 + n)}…${addr.slice(-n)}`;
}

function groupThousands(intPart: string): string {
  const neg = intPart.startsWith("-");
  const digits = neg ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `-${grouped}` : grouped;
}

/**
 * Format a raw uint256 amount with decimals using string math only (never Number on raw values).
 * `maxFrac` trims fractional digits; tiny non-zero values keep enough digits to stay non-zero.
 */
export function fmtUnits(value: bigint | string, decimals: number, maxFrac = 4): string {
  const v = typeof value === "string" ? BigInt(value) : value;
  const s = formatUnits(v, decimals);
  const [int, frac = ""] = s.split(".");
  let f = frac.slice(0, maxFrac);
  if (/^0*$/.test(f) && /[1-9]/.test(frac) && int.replace("-", "") === "0") {
    const firstSig = frac.search(/[1-9]/);
    f = frac.slice(0, Math.min(frac.length, firstSig + 3));
  }
  f = f.replace(/0+$/, "");
  return f ? `${groupThousands(int)}.${f}` : groupThousands(int);
}

/** Compact format (K / M / B) for large token amounts — display only. */
export function fmtCompact(value: bigint | string, decimals: number): string {
  const v = typeof value === "string" ? BigInt(value) : value;
  const unit = 10n ** BigInt(decimals);
  const whole = v / unit;
  const tiers: [bigint, string][] = [
    [1_000_000_000n, "B"],
    [1_000_000n, "M"],
    [1_000n, "K"],
  ];
  for (const [div, suffix] of tiers) {
    if (whole >= div) {
      const scaled = (v * 100n) / (div * unit);
      return `${groupThousands((scaled / 100n).toString())}.${(scaled % 100n).toString().padStart(2, "0")}${suffix}`;
    }
  }
  return fmtUnits(v, decimals, 4);
}

export function fmtBps(bps: number, withSign = true): string {
  const pct = (bps / 100).toFixed(2);
  return `${withSign && bps > 0 ? "+" : ""}${pct}%`;
}

export function fmtDuration(seconds: number): string {
  if (seconds <= 0) return "0s";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (d > 0) return `${d}d ${String(h).padStart(2, "0")}h ${String(m).padStart(2, "0")}m`;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export function fmtUtc(tsSeconds: number): string {
  if (!tsSeconds) return "—";
  return new Date(tsSeconds * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** Treat anything ≥ 2^128 as an "unlimited" approval (covers MAX_UINT256 / MAX_UINT160 variants). */
export function isUnlimited(amount: bigint): boolean {
  return amount >= 1n << 128n;
}
