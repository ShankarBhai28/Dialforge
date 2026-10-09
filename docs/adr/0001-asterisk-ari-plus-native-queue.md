# 0001 — ARI for calls we own, native Queue() + AMI for queueing

**Status:** Accepted (2026-09-30, Phase 8)

**Context.** We first routed inbound calls ourselves in ARI by picking one agent in SQL. That meant no real ring strategy, no hold music, and no skip-if-unreachable, all of which Asterisk's `Queue()` already does well.

**Decision.** Calls that our code drives (click-to-call, dialer legs, transfer/conference bridges) stay in ARI/Stasis. Waiting for an agent uses Asterisk's native `Queue()`. While a call is in `Queue()`, `server.js` follows it through AMI events (`AgentConnect`, `AgentComplete`, `QueueCallerAbandon`). To transfer a queue call, both legs are pulled back into Stasis through `[df-control]`.

**Consequences.** Queue behaviour is battle-tested and matches `queue show`. The cost is two event sources: anyone changing call tracking has to check both the ARI and the AMI handlers.
