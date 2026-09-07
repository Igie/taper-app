# Taper — devnet interface

The public-facing app: browse pools, create one from two mints, provide
liquidity, and swap. It talks to a real cluster through a real wallet.

This is not [`../ui`](../ui). That one is a localnet instrument — a burner
keypair, self-minted test tokens, a steerable clock, and every admin lever
exposed. This one assumes you are a user, not the person debugging the
program. Both import the ABI from [`@taper/sdk`](../sdk), so neither can drift
from the other.

## Running it

```powershell
bun install          # from the repo root: this is a workspace
bun run --cwd app dev
```

Defaults to devnet. The network selector also offers localnet, which is the
quickest way to click through the whole thing without spending devnet SOL —
start it with `.\scripts\start-localnet.ps1` first.

### Configuration

`app/.env`, all optional:

```
VITE_TAPER_ADMIN=<the authority that published this deployment's presets>
VITE_DEVNET_RPC=<an RPC that allows getProgramAccounts>
VITE_LOCALNET_RPC=http://127.0.0.1:8899
```

`VITE_TAPER_ADMIN` is what lets the app label presets as its own rather than as
third-party, and what reveals the publishing panel to that wallet. Unset, the
app still works — it simply calls every preset third-party, which is honest.

## Deploying to a fresh cluster

```powershell
.\scripts\deploy-devnet.ps1                    # the program
bun run --cwd app configs:init                 # the ladder presets
```

The second step is not optional. A pool is opened *against a config*, so until
one exists the program is deployed but nothing can be created. `configs:init`
is idempotent and reports what it skipped.

## What is worth knowing

**Confirmation is polled, never subscribed.** `confirmTransaction` opens a
WebSocket, which the LiteSVM localnet does not have, so it would hang there
forever. `lib/tx.ts` polls `getSignatureStatuses` on every cluster.

**The compute limit is always set.** Deriving a bin price costs roughly 10k CU
and every instruction in this program touches bins, so the 200k default is not
enough for anything interesting.

**The swap quote is a mirror, not an estimate.** `quoteSwap` in the SDK
reproduces the program's swap walk — the same rounding, the same per-bin fee,
the same volatility accumulation — because `min_amount_out` is the only thing
protecting a trader, and a bound computed from a guess either rejects good
fills or permits bad ones. `ui/scripts/e2e.ts` asserts the quote predicts a
real swap to the lamport.

**SOL is not a token, so the app wraps it.** A pool holds token accounts, so a
SOL pair is really a wrapped-SOL pair: `So111…112`, an ordinary SPL mint as far
as the program is concerned. `lib/native.ts` treats the wrapped account as
scratch space — created and funded at the top of a transaction, closed at the
bottom of it — so you pay in SOL, are paid in SOL, and are never left holding a
wSOL balance to clean up. The cost of that rule is that a wSOL balance you were
keeping on purpose is unwrapped along with it, which the panels say. Rent is
paid in SOL and cannot come out of a wrapped balance, which is why the max
button stops short of the whole balance on the SOL side.

**The mint fields list what you hold.** SOL first, then every token in the
wallet, largest first, each screened against what `initialize_pool` accepts —
a mint the program would reject is shown disabled with the reason rather than
hidden. Pasting an address still works: a pool can be opened against a token
this wallet has never held.

**There is no indexer.** Pools and positions come from `getProgramAccounts`
filtered by `dataSize`, which is fine at devnet scale and would not be at
mainnet scale. The reads are batched — one `getProgramAccounts` per account
type, then one `getMultipleAccounts` for every mint and one for every reserve —
because the request *count* is what a public endpoint rate-limits on.

**The endpoint is the user's choice, not only the build's.** `VITE_DEVNET_RPC`
sets what this deployment ships with, but it is baked into the bundle: it is
public to everyone who opens the app, it is one shared quota, and it cannot
help a visitor whose page is already loaded and already being throttled. The
RPC chip in the header names the host the app is talking to and takes another
one — saved in that browser's `localStorage`, for that cluster only, and sent
nowhere but to the RPC itself. That is where somebody's own Orbitflare or
Helius endpoint goes; it never has to touch this repo.

**In dev that endpoint is proxied, because some of them cannot be called from a
page at all.** Every RPC call is `content-type: application/json`, which always
triggers a CORS preflight, and an endpoint can answer the POST with a correct
`access-control-allow-origin` while answering the `OPTIONS` before it with a
JSON-RPC error and no CORS headers — Orbitflare's devnet endpoint does exactly
that, so the browser blocks the request and the whole app reads as offline.
`vite.config.ts` therefore forwards `/rpc/devnet` to whatever `VITE_DEVNET_RPC`
names, and the page makes a same-origin request; the key stays on the machine
running the dev server instead of going into the bundle. A production build has
no dev server behind it, so a *deployed* app still needs an endpoint that
answers preflight — that is the check to run before putting one in `.env` for a
build.

A failed read says which of the two things went wrong, because they look
identical on screen and have opposite fixes: `isEndpointFailure` in
`lib/cluster.ts` separates "the endpoint refused" (429, 403, a method not
enabled, no answer at all) from "the chain says no", and only the first
suggests changing endpoints. The header does the same for the program check —
an RPC that does not answer used to read as *program not found*, which sends
you off to redeploy a program that is already there.

**Presets are shown, not gated.** Every config on chain is listed whoever
published it, because hiding third-party ones would not stop pools being built
on them — it would only stop you recognising one. Creating a config is offered
only to `VITE_TAPER_ADMIN`, but that is this app's policy: on chain,
`initialize_config` takes any signer.

## Layout

```
src/
  lib/cluster.ts    which chain, through which endpoint, and explorer links
  lib/providers.tsx cluster + wallet + toast context
  lib/tx.ts         send, poll to confirm, make program errors readable
  lib/data.ts       every chain read
  lib/accounts.ts   the trader's ATAs, created on demand
  lib/native.ts     wrapping and unwrapping SOL around a transaction
  lib/presets.ts    this deployment's presets and its admin gate
  views/            pools, pool detail, create, positions, presets
  components/       the ladder chart, the RPC and token pickers, form primitives
scripts/init-configs.ts   publishes the presets
scripts/sol-e2e.ts        the SOL lifecycle, against a running localnet
```

## Checking the SOL path

```powershell
.\scripts\start-localnet.ps1
bun run --cwd app sol:e2e
```

Creates a SOL pair, deposits into it, swaps, and withdraws, asserting at each
step that the wrapped account is closed again and that the lamports moved as
SOL. Wrapping is invisible on chain — a missing `sync_native` fails three
instructions later as "insufficient funds" — so it is worth a test of its own.
The localnet seeds the native mint the way a real cluster's genesis does;
without that seeding this is the one cluster where SOL cannot be pooled.
