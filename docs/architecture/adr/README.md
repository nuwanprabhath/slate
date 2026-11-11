# Architecture decision records

Slate had no ADR convention before this folder (only [`golden-paths.md`](../golden-paths.md), which
records accepted paths, not the reasoning that chose them). This is the convention, established with
0001; it is deliberately small.

- One file per decision, `NNNN-short-slug.md`, numbered in the order written, never renumbered.
- Each file has, in this order: **Status**, **Context**, **Options considered**, **Decision**,
  **Consequences**, **Measured baseline**. The baseline is not optional: a decision about cost cites
  numbers somebody measured, with the report they came from and the conditions they were taken under,
  or says plainly that the number is unmeasured.
- **Status** carries one line only the maintainer fills in — `Decision: accept / reject / defer` with
  a date. An agent never fills it. Until it is filled, the record is a proposal.
- A superseded record is not deleted: its Status gains `Superseded by NNNN`.
- `docs/decisions/` is the compliance decision log (D-1, D-2, …) and stays where it is; it records
  decisions about the cryptographic module's use, not architecture.
