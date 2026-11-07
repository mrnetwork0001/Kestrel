import type { Address } from "viem";

/**
 * LayerZero V2 wiring of the $VIBES OFT mesh — verified live 2026-11-07:
 *  - endpoint.eid() on Base = 30184, on Robinhood Chain = 30416
 *  - BaseAdapter.peers(30416) = RH adapter, RHAdapter.peers(30184) = Base adapter
 *  - both adapters run the same Sourcify-verified `VibesOFTAdapter` source (Base: full match;
 *    RH: identical runtime bytecode + CBOR metadata hash, only immutables differ)
 */
export type LzChainId = 8453 | 4663;

export const LAYERZERO = {
  eid: { 8453: 30184, 4663: 30416 },
  endpointV2: {
    8453: "0x1a44076050125825900e736c501f859c50fE728c",
    4663: "0x6F475642a6e85809B1c36Fa62763669b1b48DD5B",
  },
  vibesAdapter: {
    8453: "0x408021Cb4ef1033675C70CF97788F3E03f45A381",
    4663: "0x37F26e3025b3DC50e0EE9f610D386803B42D0685",
  },
  scanApi: "https://scan.layerzero-api.com/v1",
  scanUi: "https://layerzeroscan.com",
} as const satisfies {
  eid: Record<LzChainId, number>;
  endpointV2: Record<LzChainId, Address>;
  vibesAdapter: Record<LzChainId, Address>;
  scanApi: string;
  scanUi: string;
};

/** Display names for the DVNs configured on the VIBES pathway (source: metadata.layerzero-api.com/v1/metadata/deployments). DVN addresses themselves are always read live from endpoint.getConfig(). */
export const LZ_DVN_NAMES: Record<string, string> = {
  "0x9e059a54699a285714207b43b055483e78faac25": "LayerZero Labs", // Base
  "0xcd37ca043f8479064e10635020c65ffc005d36f6": "Twinstake", // Base
  "0xd01ae6905d48315f7be10c7330aecf8360ef5b12": "LayerZero Labs", // Robinhood
  "0x0ffe02df012299a370d5dd69298a5826eacafdf8": "Twinstake", // Robinhood
};

/** LayerZero Scan pathway ids (srcEid-dstEid-srcOApp-dstOApp), lowercase as the API returns them. */
export const VIBES_LZ_PATHWAYS = {
  "base->robinhood": "30184-30416-0x408021cb4ef1033675c70cf97788f3e03f45a381-0x37f26e3025b3dc50e0ee9f610d386803b42d0685",
  "robinhood->base": "30416-30184-0x37f26e3025b3dc50e0ee9f610d386803b42d0685-0x408021cb4ef1033675c70cf97788f3e03f45a381",
} as const;
