# Crowd-Funding Pool Lifecycle

This document describes the complete lifecycle of a crowd-funded escrow on Stellar Crowd Fund Escrow — from pool creation through to successful completion or cancellation.

---

## Overview

A crowd-funded escrow is a special escrow type where the client side is replaced by a pool of contributors. Any number of wallets can contribute XLM (or USDC) toward a shared funding target. Once the target is reached the escrow transitions to the normal milestone-based workflow. If the target is not reached by the deadline the contract automatically refunds every contributor.

---

## State Diagram

```
                         ┌─────────────────────────────────────────────────────┐
                         │                    POOL STATES                      │
                         └─────────────────────────────────────────────────────┘

  create_pool()
       │
       ▼
  ┌─────────┐   contribute()    ┌──────────────┐   target reached    ┌──────────────┐
  │  OPEN   │ ────────────────► │   FUNDING    │ ──────────────────► │   FUNDED     │
  └─────────┘                   └──────────────┘                     └──────────────┘
       │                               │                                    │
       │  cancel_pool()                │ deadline passed,                   │ approve_milestones()
       │  (owner only, before          │ target not met                     │
       │   first contribution)         ▼                                    ▼
       │                        ┌──────────────┐                    ┌──────────────┐
       └───────────────────────►│  CANCELLED   │◄───────────────────│   ACTIVE     │
                                └──────────────┘  cancel_pool()     └──────────────┘
                                       │          (DAO vote)               │
                                       │                                   │ all milestones
                                       │ refund_all()                      │ approved
                                       ▼                                   ▼
                                ┌──────────────┐                    ┌──────────────┐
                                │  REFUNDING   │                    │  COMPLETED   │
                                └──────────────┘                    └──────────────┘
                                       │
                                       │ all refunds confirmed
                                       ▼
                                ┌──────────────┐
                                │  REFUNDED    │
                                └──────────────┘
```

---

## States

| State | Description |
|-------|-------------|
| `OPEN` | Pool contract deployed. No contributions accepted yet. Owner can set or adjust the funding target and deadline. |
| `FUNDING` | At least one contribution received. Pool is accepting contributions from any wallet. |
| `FUNDED` | Funding target reached. No further contributions accepted. Pool transitions automatically. |
| `ACTIVE` | Milestones approved by the pool governance vote. Freelancer can begin work and submit milestones. |
| `CANCELLED` | Pool cancelled — either by owner before first contribution, by deadline miss, or by DAO governance vote. |
| `REFUNDING` | Refund processing underway. The contract emits one `ContributorRefunded` event per contributor. |
| `REFUNDED` | All contributor refunds confirmed on-chain. Terminal state. |
| `COMPLETED` | All milestones approved and final payment released to freelancer. Terminal state. |

---

## Transitions in Detail

### `OPEN → FUNDING`
- **Trigger:** First `contribute()` call received
- **Contract action:** Records contributor address and amount; updates `pool.totalContributed`
- **Event emitted:** `PoolContributionReceived { pool_id, contributor, amount, total_contributed }`

### `FUNDING → FUNDED`
- **Trigger:** `pool.totalContributed >= pool.targetAmount` after a contribution
- **Contract action:** Closes the contribution window atomically; stores final contributor list
- **Event emitted:** `PoolTargetReached { pool_id, total_contributed, contributor_count }`
- **Note:** Contributions that arrive in the same ledger as the final contribution and would exceed the target are rejected with `ERR_POOL_CLOSED`.

### `FUNDED → ACTIVE`
- **Trigger:** `approve_milestones()` called by pool governance (≥ threshold of contributor weight)
- **Contract action:** Sets milestone schedule; transitions escrow from pool to standard milestone workflow
- **Event emitted:** `EscrowActivated { escrow_id, pool_id, milestone_count }`

### `FUNDING → CANCELLED` (deadline miss)
- **Trigger:** `process_deadline()` called after `pool.deadline` has passed and `pool.totalContributed < pool.targetAmount`
- **Contract action:** Locks pool against further contributions; queues refund for every contributor
- **Event emitted:** `PoolDeadlineMissed { pool_id, total_contributed, target_amount, contributor_count }`

### `FUNDED/ACTIVE → CANCELLED` (DAO vote)
- **Trigger:** DAO cancellation vote reaches quorum
- **Contract action:** Halts active milestones; freezes any unreleased escrow balance for refund
- **Event emitted:** `PoolCancelled { pool_id, reason, vote_id }`

### `CANCELLED → REFUNDING`
- **Trigger:** `refund_all()` called (permissionless — anyone can call it to trigger processing)
- **Contract action:** Iterates the stored contributor list; issues one Stellar payment per contributor proportional to their contribution
- **Event emitted:** `RefundBatchStarted { pool_id, contributor_count }`

### `REFUNDING → REFUNDED`
- **Trigger:** Last `ContributorRefunded` event confirmed on-chain
- **Contract action:** Sets pool status to `REFUNDED`; clears contributor storage entries
- **Event emitted:** `PoolRefunded { pool_id, total_refunded, contributor_count }`

### `ACTIVE → COMPLETED`
- **Trigger:** Final milestone approval vote passes
- **Contract action:** Releases remaining balance to freelancer; writes reputation record for both parties
- **Event emitted:** `EscrowCompleted { escrow_id, pool_id, freelancer, total_released }`

---

## Time-Based Triggers

The `process_deadline()` function is called by the off-chain scheduler worker (`backend/workers/scheduler.js`) every 60 seconds. It queries all `FUNDING` pools whose `deadline` field is in the past and calls the contract entry point for each.

This means deadline enforcement has up to a 60-second lag. Pools do not auto-expire client-side — the Soroban contract requires an explicit invocation to transition state.

---

## Minimum and Maximum Contributions

| Parameter | Default | Override |
|-----------|---------|----------|
| Minimum contribution | `1 XLM` / `1 USDC` | Set in `create_pool()` via `min_contribution` |
| Maximum single contribution | No limit | Set via `max_contribution_per_wallet` |
| Maximum total contributors | `500` | Configurable up to `1000` at pool creation |

Contributions below `min_contribution` are rejected at the contract level with `ERR_CONTRIBUTION_TOO_SMALL`.

---

## Refund Mechanics

Refunds are issued in the same token as the original contribution (XLM refunds for XLM contributions, USDC refunds for USDC contributions). Mixed-token pools process each token batch separately.

If a contributor's refund fails (e.g. account not accepting the asset), the contract records the failed refund in a `pending_refunds` data entry. Failed refunds can be retried permissionlessly by calling `retry_refund(contributor_address)`.

---

## On-Chain Events Reference

| Event | Emitted When |
|-------|-------------|
| `PoolCreated` | `create_pool()` succeeds |
| `PoolContributionReceived` | Any `contribute()` succeeds |
| `PoolTargetReached` | Contribution pushes total to or past target |
| `PoolDeadlineMissed` | `process_deadline()` finds an expired, underfunded pool |
| `PoolCancelled` | Governance vote or owner cancellation |
| `RefundBatchStarted` | `refund_all()` begins processing |
| `ContributorRefunded` | Individual contributor refund confirmed |
| `PoolRefunded` | All refunds complete |
| `EscrowActivated` | Pool moves to milestone phase |
| `EscrowCompleted` | Final milestone approved, balance released |

For full event payload schemas see [event-schema.md](event-schema.md).

---

## Related Documents

- [Milestone State Machine](milestone-state-machine.md) — how milestones progress after a pool reaches `ACTIVE`
- [Event Schema Reference](event-schema.md) — full topic and data payloads for all contract events
- [Reputation Scoring](reputation-scoring.md) — how completion and cancellation affect on-chain scores
- [Governance Guide](governance-guide.md) — contributor voting weight and quorum rules
