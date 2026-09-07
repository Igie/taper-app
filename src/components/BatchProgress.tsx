/**
 * Where a multi-transaction plan has got to.
 *
 * The list is not decoration: a plan that stops halfway leaves real positions
 * open on chain, and the only way a user can act on that is to see which ones.
 * So every step keeps its row after the run ends, a failed step keeps its
 * message, and anything that reached the cluster keeps its signature — a step
 * whose outcome is genuinely unknown is worth reading on an explorer before
 * touching anything else.
 */
import type { StepStatus } from "../lib/batch";

const MARK: Record<StepStatus["state"], string> = {
  pending: "·",
  running: "→",
  done: "✓",
  skipped: "=",
  failed: "✕",
  unknown: "?"
};

const NOTE: Partial<Record<StepStatus["state"], string>> = {
  skipped: "already done",
  unknown: "outcome unknown"
};

export function BatchProgress({
  statuses,
  explorer
}: {
  statuses: StepStatus[];
  explorer?: (signature: string) => string;
}) {
  if (!statuses.length) return null;
  const done = statuses.filter((s) => s.state === "done" || s.state === "skipped").length;

  return (
    <div className="batch">
      <div className="batch-head">
        <strong>
          {done} of {statuses.length} transactions
        </strong>
      </div>
      <ol className="batch-steps">
        {statuses.map((step) => (
          <li key={step.id} className={`batch-step ${step.state}`}>
            <span className="batch-mark mono" aria-hidden>
              {MARK[step.state]}
            </span>
            <span className="batch-label">{step.label}</span>
            {step.signature && explorer && (
              <a className="link mono" href={explorer(step.signature)} target="_blank" rel="noreferrer">
                {step.signature.slice(0, 8)}
              </a>
            )}
            {(step.detail || NOTE[step.state]) && (
              <small className={step.state === "failed" || step.state === "unknown" ? "warn" : "hint"}>
                {step.detail ?? NOTE[step.state]}
              </small>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
