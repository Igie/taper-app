/**
 * Choosing a mint.
 *
 * A pool is opened against two mint addresses and nothing else, so the address
 * is what this component produces. Everything around it exists because an
 * address is not what anyone has in mind: they have a *token* in mind, and the
 * chain cannot name one.
 *
 * The list is a dialog rather than a row of chips for a reason that only shows
 * up on a real wallet. A wallet holds every airdrop it has ever been sent —
 * NFTs, closed-out dust, mints with no name — and inline chips have to show all
 * of it or arbitrarily cut it off. A dialog can afford a search field, a
 * per-row balance, a USD column and a filter, which between them turn "forty
 * truncated addresses" into a list you can find something in.
 *
 * Three rules it works to:
 *
 * **What is hidden is counted, never dropped.** Empty balances and NFTs are
 * filtered by default and the toggle says how many that was. A token that has
 * silently vanished from a picker reads as a missing balance, which is the one
 * thing a person will not debug.
 *
 * **A token the program would reject is shown, disabled, with the reason.**
 * Same argument, and it is the whole point of screening client side.
 *
 * **The address always works.** Jupiter names mainnet mints and nothing else,
 * so on devnet and localnet every row falls back to what the chain said — and
 * a mint no list has ever heard of is still reachable by pasting it into the
 * search field. The picker adds names; it never gates on them.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { mintRejection } from "taper-amm-sdk";
import type { WalletToken } from "../lib/data";
import { covers, metadataFor, searchTokens, type JupToken } from "../lib/jupiter";
import { useCluster } from "../lib/providers";
import { amount as fmtAmount, shortAddress, usd as fmtUsd } from "../lib/format";
import { Modal } from "./primitives";

/** Why a held token is out of the default list. Both are counted, not dropped. */
type Hidden = "empty" | "nft";

function hiddenReason(token: WalletToken): Hidden | undefined {
  if (token.balance === 0n) return "empty";
  // An NFT is one indivisible unit of a supply of one. Semi-fungibles and
  // whole-unit tokens both have decimals 0 too, which is why the supply is
  // part of the test rather than the decimals alone.
  if (token.decimals === 0 && token.supply === 1n) return "nft";
  return undefined;
}

/** A row, whichever of the two sources it came from. */
type Row = {
  address: string;
  symbol: string;
  name?: string;
  icon?: string;
  decimals: number;
  /** Undefined for a search result: it is a token, not a holding. */
  balance?: bigint;
  usdValue?: number;
  isNative: boolean;
  token2022: boolean;
  verified: boolean;
  /** A sentence if `initialize_pool` would refuse this mint. */
  rejection?: string;
  hidden?: Hidden;
};

function heldRow(token: WalletToken, meta?: JupToken): Row {
  const address = token.address.toBase58();
  const whole = Number(token.balance) / 10 ** token.decimals;
  return {
    address,
    // Jupiter's symbol wins over the on-chain one only when there is one:
    // a Token-2022 mint carries its own name and that is authoritative for a
    // token no list has indexed.
    symbol: meta?.symbol ?? token.symbol,
    name: meta?.name ?? token.name,
    icon: meta?.icon,
    decimals: token.decimals,
    balance: token.balance,
    usdValue: meta?.usdPrice ? whole * meta.usdPrice : undefined,
    isNative: token.isNative,
    token2022: token.flag === 1,
    verified: meta?.verified ?? false,
    rejection: mintRejection(token),
    hidden: hiddenReason(token)
  };
}

function searchRow(token: JupToken): Row {
  return {
    address: token.mint,
    symbol: token.symbol,
    name: token.name,
    icon: token.icon,
    decimals: token.decimals,
    isNative: token.mint === NATIVE_MINT.toBase58(),
    token2022: token.tokenProgram === TOKEN_2022_PROGRAM_ID.toBase58(),
    verified: token.verified
  };
}

function matches(row: Row, query: string) {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    row.symbol.toLowerCase().includes(q) ||
    (row.name ?? "").toLowerCase().includes(q) ||
    row.address.toLowerCase().includes(q)
  );
}

/** The pasted-address case: a valid key is a row even if nothing has heard of it. */
function asAddress(query: string): string | undefined {
  const trimmed = query.trim();
  if (trimmed.length < 32 || trimmed.length > 44) return undefined;
  try {
    return new PublicKey(trimmed).toBase58();
  } catch {
    return undefined;
  }
}

/**
 * A token's icon, over the initials that stand in for it.
 *
 * Both are rendered rather than one or the other, because an icon URL that
 * 404s is common and a token list full of empty circles is worse than one with
 * no icons at all. The image removes itself on error and the letters underneath
 * are what is left.
 */
function TokenMark({ symbol, icon }: { symbol: string; icon?: string }) {
  return (
    <span className="token-mark" aria-hidden="true">
      {symbol.replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase() || "?"}
      {icon && <img src={icon} alt="" loading="lazy" onError={(e) => e.currentTarget.remove()} />}
    </span>
  );
}

function TokenRow({
  row,
  selected,
  taken,
  onPick
}: {
  row: Row;
  selected: boolean;
  taken: boolean;
  onPick: () => void;
}) {
  const disabled = Boolean(row.rejection) || taken;
  return (
    <button
      type="button"
      className={`token-row ${selected ? "selected" : ""}`}
      disabled={disabled}
      onClick={onPick}
      title={taken ? "Already the other side of this pair." : row.address}
    >
      <TokenMark symbol={row.symbol} icon={row.icon} />

      <span className="token-id">
        <span className="token-name">
          <strong>{row.symbol}</strong>
          {row.isNative && <span className="tag">native</span>}
          {row.token2022 && <span className="tag">2022</span>}
          {row.verified && (
            <span className="tag ok-tag" title="On Jupiter's verified list">
              ✓
            </span>
          )}
          {row.hidden === "nft" && <span className="tag">NFT</span>}
        </span>
        <span className="token-sub mono">
          {shortAddress(row.address, 6, 6)}
          {row.name && row.name !== row.symbol && <em> · {row.name}</em>}
        </span>
      </span>

      <span className="token-held">
        {row.balance === undefined ? (
          <span className="token-sub">not held</span>
        ) : (
          <>
            <strong className="mono">{fmtAmount(row.balance, row.decimals, 4)}</strong>
            {/* No line at all rather than a dash: on a network Jupiter does not
                index every row would carry one, which is a column of nothing. */}
            {row.usdValue !== undefined && <span className="token-sub mono">{fmtUsd(row.usdValue)}</span>}
          </>
        )}
      </span>

      {row.rejection && <span className="token-why">{row.rejection}</span>}
    </button>
  );
}

function TokenModal({
  title,
  value,
  taken,
  tokens,
  loading,
  connected,
  onPick,
  onClose
}: {
  title: string;
  value: string;
  taken?: string;
  tokens?: WalletToken[];
  loading: boolean;
  connected: boolean;
  onPick: (row: Row) => void;
  onClose: () => void;
}) {
  const { cluster } = useCluster();
  const indexed = covers(cluster.id);

  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [meta, setMeta] = useState<Map<string, JupToken>>(new Map());
  const [remote, setRemote] = useState<JupToken[]>([]);
  const [searching, setSearching] = useState(false);
  const field = useRef<HTMLInputElement>(null);

  useEffect(() => field.current?.focus(), []);

  // One batch for the whole wallet when the dialog opens. `metadataFor` caches
  // for half a minute, so closing and reopening costs nothing.
  const held = tokens ?? [];
  const mints = held.map((t) => t.address.toBase58()).join(",");
  useEffect(() => {
    if (!indexed || !mints) return;
    let live = true;
    void metadataFor(mints.split(",")).then((found) => live && setMeta(found));
    return () => {
      live = false;
    };
  }, [indexed, mints]);

  // The wallet is searched as you type; Jupiter's list is searched a beat
  // later, because a keystroke is not a request.
  useEffect(() => {
    if (!indexed || query.trim().length < 2) {
      setRemote([]);
      setSearching(false);
      return;
    }
    const abort = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void searchTokens(query, abort.signal)
        .then((found) => !abort.signal.aborted && setRemote(found))
        .finally(() => !abort.signal.aborted && setSearching(false));
    }, 300);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [indexed, query]);

  const rows = useMemo(() => held.map((token) => heldRow(token, meta.get(token.address.toBase58()))), [held, meta]);

  const visible = useMemo(() => {
    const kept = rows
      .filter((row) => (showHidden || !row.hidden) && matches(row, query))
      // SOL first — it is the one thing here that is not a token account, and
      // the one most pairs have on a side. Then by what a holding is worth,
      // which on a network Jupiter does not index is no order at all, so
      // balance carries it.
      .sort((a, b) => {
        if (a.isNative !== b.isNative) return a.isNative ? -1 : 1;
        const value = (b.usdValue ?? 0) - (a.usdValue ?? 0);
        if (value !== 0) return value;
        const aWhole = Number(a.balance ?? 0n) / 10 ** a.decimals;
        const bWhole = Number(b.balance ?? 0n) / 10 ** b.decimals;
        return bWhole - aWhole;
      });
    return kept;
  }, [rows, showHidden, query]);

  const hiddenCount = useMemo(
    () => rows.filter((row) => row.hidden && matches(row, query)).length,
    [rows, query]
  );

  // Anything the wallet already holds is a held row; the search only adds what
  // it does not, so nothing appears twice with two different balances.
  const heldAddresses = useMemo(() => new Set(rows.map((row) => row.address)), [rows]);
  const found = remote.filter((token) => !heldAddresses.has(token.mint)).map(searchRow);

  const pasted = asAddress(query);
  const unknown = pasted && !heldAddresses.has(pasted) && !found.some((row) => row.address === pasted);

  return (
    <Modal title={title} onClose={onClose}>
      <label className="field wide token-search">
        <input
          ref={field}
          placeholder={indexed ? "Search a symbol, a name, or paste a mint address" : "Search, or paste a mint address"}
          value={query}
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      {!connected && (
        <p className="hint">
          Connect a wallet to list what you hold. A pool can be opened against a token this wallet has never
          held, so pasting an address works either way.
        </p>
      )}
      {connected && loading && <p className="hint">Reading your balances…</p>}

      <div className="token-list">
        {visible.map((row) => (
          <TokenRow
            key={row.address}
            row={row}
            selected={row.address === value.trim()}
            taken={row.address === taken}
            onPick={() => onPick(row)}
          />
        ))}

        {found.length > 0 && (
          <>
            <p className="token-group">Not held — from Jupiter's list</p>
            {found.map((row) => (
              <TokenRow
                key={row.address}
                row={row}
                selected={row.address === value.trim()}
                taken={row.address === taken}
                onPick={() => onPick(row)}
              />
            ))}
          </>
        )}

        {unknown && (
          <>
            <p className="token-group">An address, unknown to this list</p>
            <button
              type="button"
              className="token-row"
              onClick={() =>
                onPick({
                  address: pasted,
                  symbol: shortAddress(pasted, 4, 4),
                  decimals: 0,
                  isNative: false,
                  token2022: false,
                  verified: false
                })
              }
            >
              <TokenMark symbol="?" />
              <span className="token-id">
                <span className="token-name">
                  <strong>Use this mint</strong>
                </span>
                <span className="token-sub mono">{shortAddress(pasted, 8, 8)}</span>
              </span>
              <span className="token-held">
                <span className="token-sub">reads on chain</span>
              </span>
            </button>
          </>
        )}

        {searching && <p className="hint">Searching Jupiter…</p>}

        {!loading && !searching && !visible.length && !found.length && !unknown && (
          <p className="empty">
            {query
              ? "Nothing here matches. Paste the mint address if you know it."
              : "This wallet holds no tokens on this cluster. Paste a mint address instead."}
          </p>
        )}
      </div>

      <footer className="token-foot">
        {hiddenCount > 0 ? (
          <button type="button" className="ghost" onClick={() => setShowHidden((v) => !v)}>
            {showHidden ? `Hide ${hiddenCount} NFT and empty` : `Show ${hiddenCount} NFT and empty`}
          </button>
        ) : (
          <span />
        )}
        <span className="hint dim">
          {indexed
            ? "Names, icons and prices from Jupiter. Balances and screening are read from the chain."
            : `Jupiter indexes mainnet only, so on ${cluster.label} a token is named by its own on-chain metadata and there are no prices.`}
        </span>
      </footer>
    </Modal>
  );
}

export function TokenPicker({
  label,
  value,
  onChange,
  tokens,
  loading,
  connected,
  taken
}: {
  label: string;
  value: string;
  onChange: (address: string) => void;
  tokens?: WalletToken[];
  loading: boolean;
  connected: boolean;
  /** The address chosen for the *other* side, which cannot be chosen twice. */
  taken?: string;
}) {
  const [open, setOpen] = useState(false);
  // The row that was actually chosen, kept so a token picked out of Jupiter's
  // list — one this wallet does not hold — still shows its name and icon on
  // the closed button. Reading it back out of the metadata cache would work
  // until the cache expired, and then the button would quietly become an
  // address again.
  const [picked, setPicked] = useState<Row>();
  const chosenAddress = value.trim();

  const chosen = useMemo(() => {
    if (!chosenAddress) return undefined;
    const remembered = picked?.address === chosenAddress ? picked : undefined;
    const held = tokens?.find((t) => t.address.toBase58() === chosenAddress);
    if (!held) return remembered;
    // The chain's read is authoritative about the token; the remembered row
    // is what carried the name and the icon out of the dialog.
    return { ...heldRow(held), icon: remembered?.icon, symbol: remembered?.symbol ?? held.symbol };
  }, [chosenAddress, tokens, picked]);

  return (
    <div className="token-field">
      <span className="token-label">{label}</span>

      <button type="button" className="token-select" onClick={() => setOpen(true)}>
        {chosen ? (
          <>
            <TokenMark symbol={chosen.symbol} icon={chosen.icon} />
            <span className="token-id">
              <span className="token-name">
                <strong>{chosen.symbol}</strong>
                {chosen.isNative && <span className="tag">native</span>}
                {chosen.token2022 && <span className="tag">2022</span>}
              </span>
              <span className="token-sub mono">{shortAddress(chosen.address, 6, 6)}</span>
            </span>
          </>
        ) : chosenAddress ? (
          <>
            <TokenMark symbol="?" />
            <span className="token-id">
              <span className="token-name">
                <strong>{shortAddress(chosenAddress, 6, 6)}</strong>
              </span>
              <span className="token-sub">not a token this wallet holds</span>
            </span>
          </>
        ) : (
          <span className="token-id">
            <span className="token-name">
              <strong>Choose a token</strong>
            </span>
            <span className="token-sub">from your wallet, or by address</span>
          </span>
        )}
        <span className="token-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <TokenModal
          title={label}
          value={value}
          taken={taken?.trim() || undefined}
          tokens={tokens}
          loading={loading}
          connected={connected}
          onPick={(row) => {
            setPicked(row);
            onChange(row.address);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
