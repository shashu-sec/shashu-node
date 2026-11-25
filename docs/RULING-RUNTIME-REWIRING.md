# Ruling: run-time rewiring

Recorded first in the gateway repository at
`docs/adr/ADR-007-a2a-cross-agent-lineage.md` (superseding note, 2026-09-07):

> **Standing ruling (decided early, recorded here for the first time): Shashu
> does not ship anything that rewires another company's library at run time.**
> Enterprise security review rejects run-time patching. The middleware /
> config-factory / injected-client shape the .NET and Java SDKs already use is
> **correct, not a deficiency**, and is the shape every new SDK surface takes.

## What the ruling covers, and why frameworks are different

**Decided 2026-09-13.** The standing rule applies to **provider clients** —
OpenAI, Anthropic, Google — because those sit between a customer's code and
their model vendor. After a patch, the audited artefact is no longer the
library the customer installed, and nothing at the import site says so. That
is what a security review asks about, and it is why Python's `patch_openai` /
`patch_anthropic` / `patch_google_generativeai` / `patch_all` are deprecated
and must not be the model for anything.

Extending a **framework** the customer chose, through that framework's own
callback mechanism, is carved out. The customer opted into LangChain (or an
equivalent) and into its documented callback surface. Node's
`install()` from `@trustgateai/sdk/middleware/langchain` uses that surface so
a retrieval is declared without a `callbacks` argument. It rebinds
`CallbackManager` methods; it does not sit between the customer and a model
vendor. It therefore **stays and is not deprecated**.

No new SDK surface may integrate by patching a provider client. The factory
(`shashuFetch`) patches nothing.
