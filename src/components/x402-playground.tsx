"use client";

import { useState } from "react";
import { type Address, type Hex, toHex } from "viem";
import { useAccount, useConnect, useSignTypedData } from "wagmi";
import { cx } from "@/components/ui";

interface Requirements {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}

type LogLine = { dir: "→" | "←"; text: string; tone?: "ok" | "warn" | "err" };

export function X402Playground({ defaultAddress }: { defaultAddress: string }) {
  const [address, setAddress] = useState(defaultAddress);
  const [chainId, setChainId] = useState(8453);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [reqs, setReqs] = useState<Requirements | null>(null);
  const { address: wallet, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { signTypedDataAsync } = useSignTypedData();

  const push = (l: LogLine) => setLog((x) => [...x, l]);
  const url = (mode: string) => `/api/v1/guard?address=${address}&chainId=${chainId}&mode=${mode}`;

  async function call(mode: "preview" | "full", headers: Record<string, string> = {}) {
    setBusy(true);
    push({ dir: "→", text: `GET ${url(mode)}${headers["X-PAYMENT"] ? "  [X-PAYMENT: " + headers["X-PAYMENT"].slice(0, 24) + "…]" : ""}` });
    try {
      const res = await fetch(url(mode), { headers });
      const body = await res.json();
      if (res.status === 402) {
        setReqs(body.accepts?.[0] ?? null);
        push({ dir: "←", tone: "warn", text: `HTTP 402 Payment Required\n${JSON.stringify(body, null, 2)}` });
      } else if (!res.ok) {
        push({ dir: "←", tone: "err", text: `HTTP ${res.status}\n${JSON.stringify(body, null, 2)}` });
      } else {
        const pr = res.headers.get("X-PAYMENT-RESPONSE");
        const shown = mode === "full" ? { verdict: body.verdict, riskScore: body.riskScore, band: body.band, reasons: body.reasons?.slice(0, 4), tier: body.tier } : body;
        push({ dir: "←", tone: "ok", text: `HTTP 200${pr ? `  X-PAYMENT-RESPONSE: ${atob(pr)}` : ""}\n${JSON.stringify(shown, null, 2)}` });
      }
    } catch (e) {
      push({ dir: "←", tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function payAndRetry() {
    if (!reqs || !wallet) return;
    const now = Math.floor(Date.now() / 1000);
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
    const authorization = { from: wallet, to: reqs.payTo, value: reqs.maxAmountRequired, validAfter: String(now - 60), validBefore: String(now + reqs.maxTimeoutSeconds), nonce };
    push({ dir: "→", text: `eth_signTypedData_v4 · TransferWithAuthorization ${Number(reqs.maxAmountRequired) / 1e6} USDC → ${reqs.payTo}` });
    try {
      const signature = await signTypedDataAsync({
        domain: { name: reqs.extra.name, version: reqs.extra.version, chainId: 8453, verifyingContract: reqs.asset },
        types: {
          TransferWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" },
          ],
        },
        primaryType: "TransferWithAuthorization",
        message: { from: wallet, to: reqs.payTo, value: BigInt(authorization.value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce },
      });
      const payload = { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } };
      await call("full", { "X-PAYMENT": btoa(JSON.stringify(payload)) });
    } catch (e) {
      push({ dir: "←", tone: "err", text: `Signature rejected: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
    }
  }

  return (
    <div className="panel">
      <div className="flex flex-col gap-2 border-b hairline p-3 md:flex-row">
        <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))} className="rounded-[2px] border hairline bg-canvas px-2 py-2 mono text-[12px] text-ink">
          <option value={8453}>Base 8453</option>
          <option value={4663}>Robinhood 4663</option>
        </select>
        <input value={address} onChange={(e) => setAddress(e.target.value.trim())} spellCheck={false} className="flex-1 rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[12px] text-ink focus:border-phosphor/50 focus:outline-none" />
      </div>
      <div className="flex flex-wrap gap-2 border-b hairline p-3">
        <button disabled={busy} onClick={() => call("preview")} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink hover:border-phosphor/60 disabled:opacity-40">1 · FREE PREVIEW</button>
        <button disabled={busy} onClick={() => call("full")} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink hover:border-warn/60 disabled:opacity-40">2 · REQUEST FULL (EXPECT 402)</button>
        {isConnected ? (
          <button disabled={busy || !reqs} onClick={payAndRetry} className="rounded-[2px] bg-phosphor px-3 py-1.5 mono text-[11px] font-semibold text-canvas disabled:opacity-30">3 · SIGN x402 PAYMENT & RETRY</button>
        ) : (
          <button onClick={() => connectors[0] && connect({ connector: connectors[0], chainId: 8453 })} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink-2 hover:text-ink">connect wallet to pay (step 3)</button>
        )}
        <button onClick={() => { setLog([]); setReqs(null); }} className="ml-auto mono text-[11px] text-ink-3 hover:text-ink">clear</button>
      </div>
      <div className="max-h-[460px] min-h-[220px] overflow-auto p-4 mono text-[11px] leading-relaxed">
        {log.length === 0 && <p className="text-ink-3">Run step 1 for a free verdict, step 2 to watch the HTTP 402 x402 handshake, step 3 to sign a real EIP-3009 USDC authorization and retry.</p>}
        {log.map((l, i) => (
          <pre key={i} className={cx("mb-3 whitespace-pre-wrap", l.dir === "→" ? "text-ink-2" : l.tone === "ok" ? "text-phosphor" : l.tone === "warn" ? "text-warn" : l.tone === "err" ? "text-crit" : "text-ink-2")}>
            {l.dir} {l.text}
          </pre>
        ))}
      </div>
    </div>
  );
}
