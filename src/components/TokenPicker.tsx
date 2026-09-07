/**
 * Picking a mint by what the wallet holds, rather than by pasting an address.
 *
 * A mint address is the only thing the program takes, so the text field stays
 * — a pool can be opened against a token this wallet has never held. What the
 * list adds is the common case: SOL first (it is not a token account, so it
 * would otherwise never appear), then everything held, largest first.
 *
 * A token the program would reject is shown and disabled rather than hidden.
 * Silently omitting it reads as a missing balance; saying why is the whole
 * point of screening client side.
 */
import { PublicKey } from "@solana/web3.js";
import { mintRejection } from "@taper/sdk";
import type { WalletToken } from "../lib/data";
import { amount as fmtAmount, shortAddress } from "../lib/format";

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
  return (
    <div className="token-field">
      <label className="field wide">
        <span>{label}</span>
        <input
          className="mono"
          placeholder="mint address"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>

      {!connected && <p className="hint">Connect a wallet to pick from the tokens you hold.</p>}
      {connected && loading && <p className="hint">Reading your balances…</p>}
      {connected && !loading && tokens && tokens.length === 0 && (
        <p className="hint">This wallet holds no tokens on this cluster. Paste a mint address instead.</p>
      )}

      {connected && tokens && tokens.length > 0 && (
        <div className="token-chips">
          {tokens.map((token) => {
            const address = token.address.toBase58();
            const rejection = mintRejection(token);
            const disabled = Boolean(rejection) || address === taken;
            return (
              <button
                key={address}
                type="button"
                className={`token-chip ${address === value.trim() ? "selected" : ""}`}
                disabled={disabled}
                title={
                  rejection ??
                  (address === taken ? "Already the other side of this pair." : address)
                }
                onClick={() => onChange(address)}
              >
                <strong>{token.symbol}</strong>
                <span className="mono">{fmtAmount(token.balance, token.decimals, 4)}</span>
                {token.isNative && <span className="tag">native</span>}
                {token.flag === 1 && <span className="tag">2022</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The symbol a picked address is known by, for prose that names it. */
export function symbolFor(tokens: WalletToken[] | undefined, mint: PublicKey) {
  return tokens?.find((t) => t.address.equals(mint))?.symbol ?? shortAddress(mint.toBase58());
}
