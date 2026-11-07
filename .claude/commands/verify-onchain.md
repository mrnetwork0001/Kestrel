Run `node scripts/verify-onchain.mjs` and inspect all API routes under `src/app/api/` to verify that:
1. Base Mainnet (`8453`) and Robinhood Chain Mainnet (`4663`) RPC calls succeed with zero `HTTP 403` errors (`User-Agent` header present on Robinhood transport).
2. Zero hardcoded/mock prices, reserves, or fake statuses exist anywhere in `src/`.
3. All token math uses `BigInt` (`src/lib/amm-math.ts`) without unsafe JS `Number` casts on raw wei values.
4. Every contract write action runs `publicClient.simulateContract` before requesting a wallet signature.
