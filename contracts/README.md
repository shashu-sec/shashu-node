# contracts/ — vendored, not authored here

Three files, all copies, each governing something different.
`rag_context.v1.schema.json` governs the **wire shape** the SDK sends;
`sdk-surface.v1.md` governs the **public API** a customer types — two public
retrieval functions and no third, the argument order, and the config surface
including the verbatim "no gateway address" error;
`decision-envelope.v1.md` governs what the SDK **reads back** — the six
decisions, the body key and the `x-shashu-*` header names. A change can be
legal under one and forbidden by another.

`decision-envelope.v1.md` was vendored on 2026-09-08 from the gateway's
`core/app/contract/envelope.py` (worked wire samples at
`docs/contracts/MESSAGE-FORMAT.md`). It carries no digest, for the same reason
`sdk-surface.v1.md` does not: nothing executes it, `tests/test_decision.py`
pins every name that matters against it, and a second sha256 in this file is a
second fact to drift — which
`tests/test_contract_sync.py::test_the_readme_pins_exactly_one_digest`
forbids outright.

**2026-09-13 refresh.** `sdk-surface.v1.md` and `decision-envelope.v1.md` were
refreshed from gateway `origin/main` at `8f8d92c3`. `sdk-surface.v1.md` then
gained one section authored here, "Which session a request joins" (SDK 0.16.0),
which the gateway's canonical copy does NOT have yet: the identical addition is
owed there. The envelope copy records, at its top, one drift it found in the
gateway rather than reconciling it.

**The gateway's canonical copy needs a paired change of its own.** Adding
`shashu_decision` and `is_shashu_block` to this SDK's public surface is a
change to `sdk-surface.v1.md`, which is authored in the gateway repository.
This repo's copy is updated; the gateway's is not, and there is no cross-repo
sync to do it (see below). Whoever lands this is responsible for making the
identical addition there.

`sdk-surface.v1.md` is enforced here by `tests/test_surface.py`, which asserts
`__all__` is exactly the expected set (so a leaked export fails the build), the
documented argument order, and the frozen config error. It carries no digest on
purpose: nothing executes it, the surface test pins the values that matter, and
a second sha256 in this file is a second fact to drift —
`tests/test_contract_sync.py::test_the_readme_pins_exactly_one_digest` enforces
that there is only ever one.

`rag_context.v1.schema.json` is a **copy**. The single definition lives in the
gateway repository (`aisquad001/shashu`) at the same path, and the four
SDKs vendor it rather than restating its rules, so a payload that validates in
one client validates in all of them.

**The copy is manual, and stays manual until a cross-repo credential exists.**
Nothing in CI fetches the gateway's file or compares the two; if the contract
changes there, this copy goes stale silently.

That is a decision, not an oversight. Fetching the gateway's copy from this
repo's CI needs a credential that can read a private repository, and this
repository has none — measured 2026-09-05 against `aisquad001/shashu-python`:
no repository secrets, no Dependabot secrets, no secrets on the only
environment (`pypi`, which publishes over tokenless OIDC Trusted Publishing),
and `aisquad001` is a **User** account, so organisation secrets are impossible
rather than merely absent. A drift job written against a secret that does not
exist either fails every PR until somebody switches it off, or is written to
pass when the fetch fails — a check that goes green exactly when it cannot do
its job. Neither is worth having.

So the refresh is a documented manual step, and what CI enforces is the half it
can:

* `tests/test_retrieval_bus.py::test_vendored_schema_is_the_copy_we_took` holds
  the file to a digest, so a hand-edit fails the suite instead of quietly
  widening what the SDK will send.
* `tests/test_contract_sync.py` holds the digest recorded **below** to the
  bytes on disk, and to the one that test hardcodes — so a refresh that updates
  the file but forgets either place the digest is written down also fails.

**When the gateway repo becomes reachable from CI** (a fine-grained PAT with
read access to `aisquad001/shashu`, or the two repos moving under one
organisation), replace the manual step with a job that fetches
`contracts/rag_context.v1.schema.json` from the gateway's default branch and
compares its sha256 to the digest below. Until then, whoever changes the
contract in the gateway repo is responsible for refreshing the four SDK copies.

* Taken from `origin/main` of the gateway repo on 2026-09-05
* `sha256` of the copy, byte for byte identical to the source at that commit:
  `25894f3aedbfe96e7e1cdd12ab56d1a316eed8b8fb4dcad603ed4c0d67574fee`

To refresh it: copy the gateway file in verbatim, update the digest above and
in the test, and re-run the suite — the payloads the SDK builds are validated
against this file, so a contract change shows up as a test failure rather than
as a rejected request in a customer's stack.
