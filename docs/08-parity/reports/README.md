# Parity loop reports

One report per 3-hour tick of the [parity loop](../README.md#how-the-loop-works), named
`YYYY-MM-DD-HHMM.md` for when the tick ended. Each report covers what landed (with
SHAs), the parity score from `node scripts/parity-score.ts`, what comes next, and
anything blocked on the owner. The newest file is the state when the loop last ran, on
2026-09-30. Reports are not rewritten afterwards, so "nothing has been pushed" and "the cron job
is still set" are true only of their own date. [The parity README](../README.md) has the state
since.
