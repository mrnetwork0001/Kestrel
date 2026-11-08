# Kestrel demo film

A 2:51 film made with [Remotion](https://www.remotion.dev) for the judges and $VIBES-holder voters of Vibestarter's Vibeathon 02, Night Shift. A wallet signs three unlimited approvals on Sunday morning, Kestrel scores it, pages the owner on Telegram, and the owner gets out in 32 seconds; then the Rug Lab, bridge parity, Backer Shield, the x402 agent gate and the MCP server, all from the live product.

Deliverables: `out/kestrel-demo-4k.mp4` (3840×2160, -14 LUFS), `out/kestrel-thumbnail.png` and `.jpg`. Half-scale check render: `out/draft.mp4`. YouTube title, description and chapters: `youtube.txt`. Note: standard X accounts only accept videos up to 2:20.

## What is real

- **The on-chain story (scenes 01, 05, 07, 10):** every hash, block, time and figure is read back from Base mainnet into `data/onchain.json` by `scripts/onchain.mjs` (receipts, decoded Approval and Transfer logs; read 2026-11-08 07:42 UTC). The demo wallet `0xCd0a2370F2dC12c1802707B7d9aB3fec891E3c02` granted three unlimited approvals on Sun 2026-11-08: USDC to Permit2 at 06:55:38 UTC (block 54,652,814, `0xea2c13aa…0733e`), VIBES to the Aerodrome Router at 06:56:17 (block 54,653,010, `0x22bf1d24…c941b`) and WETH to the Uniswap Universal Router at 06:56:55 (block 54,653,197, `0x86d4d64f…7ffe4`). The rescue was six transactions from 07:07:05 to 07:07:37 UTC: revoke WETH (`0xa3ca5b37…e0b4`), revoke USDC (`0x24cf9051…fb69`), approve exactly 12,358.636 VIBES and swap it for 1.963096 USDC (`0xfca37c8f…2c07`, `0x5d1a02b4…0cac`), approve exactly 0.0015 WETH and swap it for 3.346594 USDC (`0x41ce2c99…71e7`, `0x8752ce32…aa64`). The first paid x402 call settled at 07:25:19 UTC (block 54,661,721, 0.01 USDC from the demo wallet to `0xEbB92c8f27368222E4B722FB386DbC6Fe80CC426`, `0xe79c92c1…22ee`).
- **Live product numbers:** `data/live.json`, read from the production API by `scripts/live.mjs` (last read 2026-11-08 08:21 UTC): $VIBES OFT parity EXACT with Δ 0 (56,937,667.73 VIBES locked in the Base adapter equals circulating on Robinhood Chain), the Genesis escrow's 123.4597 ETH raise with 5 of 7 tranches paid, the guard verdict ALLOW on $VIBES, and the Pager's 240 s QStash cadence. "200 ms" and "144,000 blocks" are Base's live block rate shown on the Sentinel Watch (5.0 blocks a second, one block every 200 ms) times 8 hours (8 × 3,600 × 5 = 144,000), labelled as that calculation on screen.
- **The app:** recorded from the live production site, https://usekestrel.vercel.app, on 2026-11-08 between 07:57 and 08:30 UTC (`scripts/capture.mjs`, headless Chrome at 1600×900, device scale 2): the landing with the live Sentinel Watch and a scan of the $VIBES token, the Pager tab on the demo wallet with its public watch log and a dry-run evaluation, the Panic Bunker on the demo wallet now (nothing to revoke, score 0), the Rug Lab, the Parity tab, Backer Shield on the Genesis escrow, and `/agents` (the x402 playground's free verdict and HTTP 402 challenge, the revenue ledger, the MCP tool list). The capture made **no writes**: no wallet connection, no transaction, no Pager desk or watch, no payment, no message. The pager's Evaluate button is a dry run that sends nothing, and the playground's steps 1 and 2 are plain GET requests.
- **Simulations:** the Rug Lab scenes (top whale dumps 100%, 50% liquidity pulled) are simulations on live pool reserves and are labelled on screen.
- **The owner's own captures** (a real wallet cannot be scripted headlessly), in `public/footage/owner/`: screenshots of the rescue page with the owner's Rabby wallet connected at 07:04 UTC (block 54,655,460: 45/100 ELEVATED, EIP-5792 not supported so guided sequential signing, three unlimited approvals, the 6-call sign rail), the Zerion phone notifications of the rescue transactions (the film uses `zerion-rescue-notifications-safe.jpg`, made by `scripts/privacy.py`: the photo behind the translucent notifications, which showed the owner, is blurred and darkened beyond recognition and the cards are flattened, keeping only their real text and icons; the original file is untouched), and an iPhone screen recording of the Telegram chat with @KestrelNightShiftBot (recorded about 07:59 UTC; muted): the CRITICAL pages for the three approvals (blocks 54,652,814, 54,653,010 and 54,653,197) and the RESOLVED pages after the revokes (blocks 54,656,251 and 54,656,281), all matching `data/onchain.json`.
- **Basescan:** the explorer page of the first x402 settlement, captured live (scene 10). Basescan's bot check refused the headless capture of the approval and revoke pages, so those hashes appear on motion cards read from `data/onchain.json`, with every link in `youtube.txt`.
- **Logos:** Kestrel's Night Eye drawn from the app's own SVG geometry (`src/components/logo-mark.tsx`); Base lockups from the official brand kit (github.com/base-org/brand-kit); the Robinhood Chain lockup cropped, unaltered, from the official Robinhood Chain docs OG image (cdn.robinhood.com); the Vibestarter logo from app.vibestarter.xyz.
- **Narration, music and sound:** ElevenLabs. The narrator is Brian (`eleven_multilingual_v2`, each line normalised to -16 LUFS); the score is ElevenLabs Music from a sectioned composition plan timed to the film; the effects are ElevenLabs sound generation.

## Build it

The ElevenLabs key is read at runtime from `/Users/mrnetwork/Syntura/video/.env` and never stored here.

```
npm install
npm run onchain && npm run live                                # facts: read-only RPC and the production API
npm run vo && npm run timing && npm run music && npm run sfx   # audio and timing (re-run timing after music)
npm run capture && npm run encode                              # live app footage (production URL, read-only)
npm run studio                                                 # preview
node scripts/stills.mjs <frames...>                            # half-scale check stills
npm run draft                                                  # half-scale check render
npm run render4k && npm run finish                             # 4K master, audio to -14 LUFS / -1 dBTP
npm run poster && ffmpeg -i out/kestrel-thumbnail.png -q:v 3 out/kestrel-thumbnail.jpg   # thumbnail
python3 scripts/privacy.py                                     # privacy-safe Zerion image (Pillow, numpy, scipy)
```

`script.json` holds every spoken line (`say` spells a word the way it is pronounced: "U S D C", "x four oh two"); `scripts/timing.mjs` maps the spoken words back onto the written ones and writes `src/timing.json`, which places each word on the frame it is spoken, and the scenes animate on those words.
