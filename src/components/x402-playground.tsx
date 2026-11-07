"use client";

import { useState } from "react";
import { type Address, formatUnits, type Hex, parseAbi, toHex } from "viem";
import { useAccount, useChainId, useConnect, usePublicClient, useSignTypedData, useSwitchChain } from "wagmi";
import { cx } from "@/components/ui";

/** x402 v2 requirement (decoded from the PAYMENT-REQUIRED header). */
interface ReqV2 {
  scheme: "exact";
  network: "eip155:8453";
  asset: Address;
  amount: string;
  payTo: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}
/** x402 v1 requirement (JSON body of the 402). */
interface ReqV1 {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  payTo: Address;
  asset: Address;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
}
interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource: Record<string, unknown>;
  accepts: ReqV2[];
  extensions?: Record<string, unknown>;
}
type LogLine = { dir: "→" | "←"; text: string; tone?: "ok" | "warn" | "err"; href?: string };

const TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;
const USDC_READ_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const USDC_DECIMALS = 6;

/** UTF-8 safe base64 (headers carry JSON). */
const enc64 = (o: unknown) => {
  const bytes = new TextEncoder().encode(JSON.stringify(o));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const dec64 = <T,>(s: string): T | null => {
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))) as T;
  } catch {
    return null;
  }
};
const usdc = (atomic: string) => (/^\d+$/.test(atomic) ? formatUnits(BigInt(atomic), USDC_DECIMALS) : "?");

export function X402Playground({ defaultAddress }: { defaultAddress: string }) {
  const [address, setAddress] = useState(defaultAddress);
  const [chainId, setChainId] = useState(8453);
  const [version, setVersion] = useState<1 | 2>(2);
  const [ack, setAck] = useState(false);
  const [log, setLog] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [pr2, setPr2] = useState<PaymentRequiredV2 | null>(null);
  const [req1, setReq1] = useState<ReqV1 | null>(null);
  const { address: wallet, isConnected } = useAccount();
  const activeChain = useChainId();
  const { connectors, connect } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { signTypedDataAsync } = useSignTypedData();
  const basePublic = usePublicClient({ chainId: 8453 });

  const push = (l: LogLine) => setLog((x) => [...x, l]);
  const url = (mode: string) => `/api/v1/guard?address=${encodeURIComponent(address)}&chainId=${chainId}&mode=${mode}`;

  async function call(mode: "preview" | "full", headers: Record<string, string> = {}) {
    setBusy(true);
    const sent = Object.keys(headers)[0];
    push({ dir: "→", text: `GET ${url(mode)}${sent ? `\n  ${sent}: ${headers[sent].slice(0, 32)}… (${headers[sent].length} chars)` : ""}` });
    try {
      const res = await fetch(url(mode), { headers });
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      const receiptHeader = res.headers.get("PAYMENT-RESPONSE") || res.headers.get("X-PAYMENT-RESPONSE");
      const receipt = receiptHeader ? dec64<{ success?: boolean; transaction?: string; errorReason?: string }>(receiptHeader) : null;
      if (res.status === 402) {
        const h = res.headers.get("PAYMENT-REQUIRED");
        const v2 = h ? dec64<PaymentRequiredV2>(h) : null;
        const v1 = (body?.accepts as ReqV1[] | undefined)?.[0] ?? null;
        setPr2(v2);
        setReq1(v1);
        // v2 by default; fall back to v1 automatically if the server only spoke v1 (no PAYMENT-REQUIRED header).
        if (!v2 && v1 && version === 2) setVersion(1);
        const price = v2?.accepts[0]?.amount ?? v1?.maxAmountRequired;
        push({
          dir: "←",
          tone: "warn",
          text: [
            `HTTP 402 Payment Required${price ? ` · ${usdc(price)} USDC on Base` : ""}${body?.error ? ` · ${String(body.error)}` : ""}`,
            receipt ? `settlement receipt: ${JSON.stringify(receipt)}` : null,
            `PAYMENT-REQUIRED (x402 v2, decoded): ${v2 ? JSON.stringify({ ...v2, resource: { url: v2.resource?.url }, extensions: v2.extensions ? Object.keys(v2.extensions) : undefined }, null, 2) : "absent (server speaks v1 only)"}`,
            `body (x402 v1): ${JSON.stringify(body ? { ...body, accepts: (body.accepts as ReqV1[] | undefined)?.map((a) => ({ ...a, outputSchema: a && "outputSchema" in a ? "…" : undefined })) } : null, null, 2)}`,
          ]
            .filter(Boolean)
            .join("\n"),
          href: receipt?.transaction ? `https://basescan.org/tx/${receipt.transaction}` : undefined,
        });
      } else if (!res.ok) {
        push({ dir: "←", tone: "err", text: `HTTP ${res.status}\n${JSON.stringify(body, null, 2)}` });
      } else {
        const b = body ?? {};
        const shown = mode === "full" ? { verdict: b.verdict, riskScore: b.riskScore, band: b.band, reasons: (b.reasons as unknown[] | undefined)?.slice(0, 4), tier: b.tier, payment: b.payment } : b;
        push({
          dir: "←",
          tone: "ok",
          text: `HTTP 200${receipt ? `\nsettlement receipt: ${JSON.stringify(receipt)}` : ""}\n${JSON.stringify(shown, null, 2)}`,
          href: receipt?.transaction ? `https://basescan.org/tx/${receipt.transaction}` : undefined,
        });
      }
    } catch (e) {
      push({ dir: "←", tone: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function payAndRetry() {
    if (!wallet) return;
    const r = version === 2 ? pr2?.accepts[0] : req1;
    if (!r) return;
    const value = version === 2 ? (r as ReqV2).amount : (r as ReqV1).maxAmountRequired;
    if (!/^\d+$/.test(value)) return;
    setBusy(true);
    try {
      // Pre-flight (read-only): the payer must hold the USDC on Base, otherwise settlement would fail anyway.
      if (basePublic) {
        const bal = await basePublic.readContract({ address: r.asset, abi: USDC_READ_ABI, functionName: "balanceOf", args: [wallet] }).catch(() => null);
        if (bal !== null) {
          push({ dir: "←", text: `pre-flight: wallet USDC balance on Base = ${formatUnits(bal, USDC_DECIMALS)}` });
          if (bal < BigInt(value)) {
            push({ dir: "←", tone: "err", text: `Insufficient USDC: ${usdc(value)} required. Nothing was signed.` });
            return;
          }
        }
      }
      if (activeChain !== 8453) await switchChainAsync({ chainId: 8453 }); // wallets reject typed data whose domain chainId != active chain
      const now = Math.floor(Date.now() / 1000);
      const nonce = toHex(crypto.getRandomValues(new Uint8Array(32))) as Hex;
      // Same windows as the official clients: v2 validAfter=0; v1 validAfter=now-600.
      const authorization = { from: wallet, to: r.payTo, value, validAfter: version === 2 ? "0" : String(now - 600), validBefore: String(now + r.maxTimeoutSeconds), nonce };
      push({ dir: "→", text: `eth_signTypedData_v4 · TransferWithAuthorization ${usdc(value)} USDC → ${r.payTo} (x402 v${version}). Real USDC moves once the server settles.` });
      const signature = await signTypedDataAsync({
        domain: { name: r.extra.name, version: r.extra.version, chainId: 8453, verifyingContract: r.asset },
        types: TYPES,
        primaryType: "TransferWithAuthorization",
        message: { from: wallet, to: r.payTo, value: BigInt(value), validAfter: BigInt(authorization.validAfter), validBefore: BigInt(authorization.validBefore), nonce },
      });
      setBusy(false);
      if (version === 2 && pr2) {
        // v2 envelope: echo resource + extensions (bazaar) and the exact accepted requirement.
        const payload = { x402Version: 2, resource: pr2.resource, accepted: r, payload: { signature, authorization }, extensions: pr2.extensions };
        await call("full", { "PAYMENT-SIGNATURE": enc64(payload) });
      } else {
        const payload = { x402Version: 1, scheme: "exact", network: "base", payload: { signature, authorization } };
        await call("full", { "X-PAYMENT": enc64(payload) });
      }
    } catch (e) {
      push({ dir: "←", tone: "err", text: `Signature rejected: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` });
    } finally {
      setBusy(false);
    }
  }

  const haveReqs = version === 2 ? Boolean(pr2) : Boolean(req1);
  const price = version === 2 ? pr2?.accepts[0]?.amount : req1?.maxAmountRequired;
  return (
    <div className="panel min-w-0">
      <div className="flex flex-col gap-2 border-b hairline p-3 md:flex-row">
        <select value={chainId} onChange={(e) => setChainId(Number(e.target.value))} aria-label="Chain" className="rounded-[2px] border hairline bg-canvas px-2 py-2 mono text-[12px] text-ink max-[900px]:min-h-11 max-[900px]:text-[16px]">
          <option value={8453}>Base 8453</option>
          <option value={4663}>Robinhood 4663</option>
        </select>
        <input value={address} onChange={(e) => setAddress(e.target.value.trim())} spellCheck={false} aria-label="Target address" className="min-w-0 flex-1 rounded-[2px] border hairline bg-canvas px-3 py-2 mono text-[12px] text-ink focus:border-phosphor/50 focus:outline-none max-[900px]:min-h-11 max-[900px]:text-[16px]" />
        <select value={version} onChange={(e) => setVersion(Number(e.target.value) as 1 | 2)} aria-label="x402 protocol version" title="x402 protocol version used for step 3" className="min-w-0 rounded-[2px] border hairline bg-canvas px-2 py-2 mono text-[12px] text-ink max-[900px]:min-h-11 max-[900px]:text-[16px]">
          <option value={2}>x402 v2 · PAYMENT-SIGNATURE</option>
          <option value={1}>x402 v1 · X-PAYMENT</option>
        </select>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b hairline p-3">
        <button disabled={busy} onClick={() => call("preview")} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink hover:border-phosphor/60 disabled:opacity-40 max-[900px]:min-h-11 max-[600px]:flex-1">1 · FREE PREVIEW</button>
        <button disabled={busy} onClick={() => call("full")} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink hover:border-warn/60 disabled:opacity-40 max-[900px]:min-h-11 max-[600px]:flex-1">2 · REQUEST FULL (EXPECT 402)</button>
        {isConnected ? (
          <button disabled={busy || !haveReqs || !ack} onClick={payAndRetry} className="rounded-[2px] bg-phosphor px-3 py-1.5 mono text-[11px] font-semibold text-canvas disabled:opacity-30 max-[900px]:min-h-11 max-[600px]:w-full">
            3 · PAY {price ? `${usdc(price)} USDC` : ""} (v{version}) & RETRY
          </button>
        ) : (
          <button onClick={() => connectors[0] && connect({ connector: connectors[0], chainId: 8453 })} className="rounded-[2px] border border-hair-strong px-3 py-1.5 mono text-[11px] text-ink-2 hover:text-ink max-[900px]:min-h-11 max-[600px]:flex-1">connect wallet to pay (step 3)</button>
        )}
        <button onClick={() => { setLog([]); setPr2(null); setReq1(null); }} className="ml-auto mono text-[11px] text-ink-3 hover:text-ink max-[900px]:min-h-9 max-[900px]:px-2">clear</button>
      </div>
      {isConnected && (
        <label className="flex items-start gap-2 border-b hairline px-3 py-2 text-[12px] text-ink-3 max-[900px]:gap-3 max-[900px]:py-3">
          <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5 max-[900px]:h-5 max-[900px]:w-5 max-[900px]:shrink-0" />
          <span>
            I understand step 3 signs a real EIP-3009 authorization for {price ? `${usdc(price)} USDC` : "the quoted USDC price"} on Base mainnet, which Kestrel settles onchain before returning the verdict. An EOA wallet is recommended.
          </span>
        </label>
      )}
      <div className="max-h-[460px] min-h-[220px] overflow-auto p-4 mono text-[11px] leading-relaxed max-[900px]:max-h-[60vh] max-[600px]:min-h-[180px] max-[600px]:p-3">
        {log.length === 0 && (
          <p className="text-ink-3">
            Step 1 = free verdict. Step 2 = the real HTTP 402 (x402 v2 PAYMENT-REQUIRED header + v1 JSON body). Step 3 signs an EIP-3009 USDC authorization; the server verifies it through the
            facilitator, runs the scan, settles the payment onchain and only then returns the verdict + receipt.
          </p>
        )}
        {log.map((l, i) => (
          <pre
            key={i}
            className={cx(
              "mb-3 whitespace-pre-wrap [overflow-wrap:anywhere]",
              l.dir === "→" ? "text-ink-2" : l.tone === "ok" ? "text-phosphor" : l.tone === "warn" ? "text-warn" : l.tone === "err" ? "text-crit" : "text-ink-2"
            )}
          >
            {l.dir} {l.text}
            {l.href && (
              <>
                {"\n"}
                <a href={l.href} target="_blank" rel="noreferrer" className="underline">
                  view settlement on Basescan ↗
                </a>
              </>
            )}
          </pre>
        ))}
      </div>
    </div>
  );
}
