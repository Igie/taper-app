# Taper — devnet interface

The public-facing app: browse pools, create one from two mints, provide
liquidity, and swap. It talks to a real cluster through a real wallet.

This is not the localnet console it grew up beside. That one is a localnet
instrument — a burner
keypair, self-minted test tokens, a steerable clock, and every admin lever
exposed. This one assumes you are a user, not the person debugging the
program. Both import the ABI from
[`taper-amm-sdk`](https://www.npmjs.com/package/taper-amm-sdk), so neither can drift
from the other.

## Running it

```powershell
bun install
bun run dev
```

Defaults to devnet. The network selector also offers localnet, which is the
quickest way to click through the whole thing without spending devnet SOL —
start it with `.\scripts\start-localnet.ps1` first.

### Configuration

`.env`, all optional — copy `.env.example`, which is the same list with the
reasoning attached:

```
VITE_TAPER_ADMIN=<the authority that published this deployment's presets>

# what a build ships with — public to every visitor
VITE_MAINNET_RPC=
VITE_DEVNET_RPC=

# what this machine uses — proxied by the dev server, never bundled
VITE_MAINNET_RPC_DEV=
VITE_DEVNET_RPC_DEV=

VITE_LOCALNET_RPC=http://127.0.0.1:8899
```

`VITE_TAPER_ADMIN` is what lets the app label presets as its own rather than as
third-party, and what reveals the publishing panel to that wallet. Unset, the
app still works — it simply calls every preset third-party, which is honest.

**Each public network has two endpoint slots, and the difference is who gets to
see the URL.** `VITE_<NET>_RPC` is inlined into the bundle every visitor
downloads, so it is the endpoint that has to survive being public — that is the
name to set in the Vercel project, below. `VITE_<NET>_RPC_DEV` wins whenever
the dev server is running and is ignored by a production build: it is proxied
rather than inlined, so a personal key pasted there is used by the page without
ever being served to it. They are two names instead of one because pasting the
metered endpoint into the public slot is a mistake with no symptom until the
quota is gone.

### Where the rest of it lives

This repository is the interface and nothing else. The ABI arrives from npm
as [`taper-amm-sdk`](https://www.npmjs.com/package/taper-amm-sdk); its source,
the `taper-core` math it shares with the on-chain program, and the Jupiter
`Amm` implementation live in the repository of the same name,
[Igie/taper-amm-sdk](https://github.com/Igie/taper-amm-sdk). The Anchor
program, the LiteSVM integration tests and the localnet the `*:e2e` scripts
below drive are in the main repository, which is not public.

## Deploying this app

Vercel builds it from this repository with no configuration beyond
[`vercel.json`](vercel.json) — `bun install`, `bun run build`, serve `dist`.
There is no router, so there is no rewrite to add.

The `VITE_*` variables are **build-time** and land in the JS bundle every
visitor downloads. Set them in the Vercel project, not in a committed `.env`,
and put only endpoints you are willing to publish there. Anyone who needs more
throughput than a public endpoint gives points their own browser at their own
RPC from the chip in the header — that is stored in `localStorage`, never
built in, which is why the shipped default can stay public.

```
VITE_TAPER_ADMIN=<the authority that published this deployment's presets>
VITE_DEVNET_RPC=https://api.devnet.solana.com
VITE_MAINNET_RPC=https://api.mainnet-beta.solana.com
```

The `_DEV` slots have no meaning here and setting them does nothing: a Vercel
build runs in production mode, where they are not read. They are for a checkout
on a laptop, where the dev server proxies them.

## Deploying the program to a fresh cluster

The program is not in this repository. From the main one:

```powershell
.\scripts\deploy.ps1 -Cluster devnet           # the program
bun run --cwd app configs:init                 # the ladder presets
```

Mainnet is the same two commands with `-Cluster mainnet-beta` and
`configs:init -- --network mainnet-beta --yes`; the program has the same
address on every cluster. `docs/mainnet-checklist.md` there is the go-live
list.

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
fills or permits bad ones. The main repository's `ui/scripts/e2e.ts` asserts the
quote predicts a real swap to the lamport.

**SOL is not a token, so the app wraps it.** A pool holds token accounts, so a
SOL pair is really a wrapped-SOL pair: `So111…112`, an ordinary SPL mint as far
as the program is concerned. The SDK's `native.ts` treats the wrapped account as
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
`vite.config.ts` therefore forwards `/rpc/devnet` to whatever
`VITE_DEVNET_RPC_DEV` names — or `VITE_DEVNET_RPC`, if the dev slot is blank —
and the page makes a same-origin request; the key stays on the machine running
the dev server instead of going into the bundle. A production build has no dev
server behind it, so a *deployed* app still needs an endpoint that answers
preflight — that is the check to run before putting one in the shipped slot.

A failed read says which of the two things went wrong, because they look
identical on screen and have opposite fixes: `isEndpointFailure` in
`lib/cluster.ts` separates "the endpoint refused" (429, 403, a method not
enabled, no answer at all) from "the chain says no", and only the first
suggests changing endpoints. The header does the same for the program check —
an RPC that does not answer used to read as *program not found*, which sends
you off to redeploy a program that is already there.

**The pool page splits by verb, and the reasoning is one hover away.** Swap and
**New position** sit side by side, and **Manage position** is everything you can
do to an account that already exists — pick one of your positions, then add,
remove or move its band behind tabs, with *claim* and *close* in the panel
header where either tab can reach them. They are in the header rather than in a
tab because `close_position` refuses a position with a fee still pending, so the
two belong together and near.

The rule for text is that **what changes the next click stays on screen and what
explains it moves into a `HoverCard`**: the numbers that decide whether to sign —
bins funded, transactions, rent, and any warning that is actually actionable —
are visible, and the paragraph explaining *why* a bin array costs 6,792 bytes or
what a composition fee is lives behind the `i`. Nothing was deleted; it moved.

**Presets are shown, not gated.** Every config on chain is listed whoever
published it, because hiding third-party ones would not stop pools being built
on them — it would only stop you recognising one. Creating a config is offered
only to `VITE_TAPER_ADMIN`, but that is this app's policy: on chain,
`initialize_config` takes any signer.

## Layout

```
src/
  lib/cluster.ts    localStorage + VITE_* over the SDK's network table
  lib/providers.tsx cluster + wallet + toast context
  lib/tx.ts         send, poll to confirm, price the priority fee
  lib/data.ts       every chain read
  lib/accounts.ts   fetching the trader's token balances
  lib/batch.ts      signs a multi-transaction plan in order, resumably
  lib/presets.ts    this deployment's presets and its admin gate
  views/            pools, pool detail, create, positions, presets
  views/NewPosition.tsx     opening one: a band, a shape, two amounts
  views/ManagePosition.tsx  add / remove / move, with claim and close beside them
  components/DepositForm.tsx  the deposit itself, shared by both of those
  components/       the ladder chart, the RPC and token pickers, form primitives
scripts/init-configs.ts   publishes the presets
scripts/sol-e2e.ts        the SOL lifecycle, against a running localnet
```

## Bands wider than one transaction

A position may span up to 1,400 bins, but it is created holding at most 70 and
a deposit carries about 70, so a wide band is always several transactions. Two
different limits produce them: `resize_position` grows the account (the runtime
caps growth at 10,240 bytes a transaction), and `add_liquidity` fills it (the
packet caps the bps table). `taper-amm-sdk`'s `planDeposit` emits both — open,
grow, then fill — taking the shape over the *whole* band and then slicing it,
so a split deposit lays down the same curve an undivided one would.
`lib/batch.ts` signs the pieces one at a time, passing `Step.signers` along
with the wallet: a position is a keypair account, so the opening transaction is
signed by the new position as well as its owner.

Growth steps are marked `idempotent`, because `resize_position` takes a target
band rather than a delta: a step whose confirmation timed out is simply
re-sent, where an ambiguous deposit has to stop and ask.

The same instruction narrows and slides a band, which is how a range is changed
without closing the position. **Move band** on a position does exactly that:
`planRebalance` withdraws and claims over the bins that are leaving (the
program refuses to drop a bin still holding shares or an unclaimed fee), then
resizes. The bins the old and new bands share are never touched — their
liquidity stays in the pool and keeps earning, and the position keeps its
address, its fee checkpoints and its claimed totals. Filling the bins the move
adds is an ordinary deposit afterwards.

Note what a runner owes each step: `Step.signers` (an opening step is signed by
the new position too) and `CU_HEADROOM_NATIVE` on top of `step.computeUnits`
whenever it wraps token handling around one, since the whole transaction shares
a single compute limit.

The chunk width is measured rather than assumed. A packet is 1,232 bytes and a
70-bin deposit spends 280 on its bps table and 513 on its sixteen accounts, so
what this app wraps around a step — the compute-budget pair, and the SOL
wrapping when a side is native — decides whether the full width still fits.
`widthThatFits` takes that headroom and returns what is left; today it is the
whole 70, with 63 bytes spare in the worst case, and if a client ever needs more
room it narrows its own positions instead of failing to send.

The same applies in reverse: `planExit` empties, claims and closes each position
in its own transaction, and the **Remove** tab offers it over one position or
over every position in the pool.

**Rebalancing in the app is the move, not a round trip.** `resize_position`
slides a band in place, so the interface offers that and nothing else: the bins
the two bands share never leave the reserve. The older sequence — exit
everything, measure what came back, redeposit the *delta* rather than the
balance so it never sweeps tokens held for something else — is still an SDK
capability, and `wide:e2e` and `matrix:e2e` still drive it; it is simply not a
button any more, because a move keeps the account, the checkpoints and the
claimed totals that a round trip throws away.

    bun run wide:e2e

drives all of it against a running localnet: a 160-bin band opened as three
positions, every funded bin checked against the plan to the raw unit, a re-run
that correctly sends nothing, and a rebalance into a different band.

    bun run matrix:e2e

runs the same lifecycle — open, add to the *existing* positions, swap, claim
across them, withdraw half, rebalance, close — over every kind of pair: SPL/SPL,
SPL and Token-2022 with a transfer fee, two fee mints, SOL/SPL, and SOL against
a fee mint. Those variables interact and the other scripts each hold one still:
the transfer fee is quoted per bin, so a deposit split across three positions
quotes it three times, and a wrapped SOL account is opened and closed once per
transaction, so a plan of three is three wraps rather than one. Every step runs
at the compute limit the planner predicted, which is how a Token-2022 transfer
costing more than an SPL one would show up.

## Checking the SOL path

```powershell
.\scripts\start-localnet.ps1
bun run sol:e2e
```

Creates a SOL pair, deposits into it, swaps, and withdraws, asserting at each
step that the wrapped account is closed again and that the lamports moved as
SOL. Wrapping is invisible on chain — a missing `sync_native` fails three
instructions later as "insufficient funds" — so it is worth a test of its own.
The localnet seeds the native mint the way a real cluster's genesis does;
without that seeding this is the one cluster where SOL cannot be pooled.
