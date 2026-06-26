# ITIL — Change, Incident, and Problem Management

## Change Management (ITIL 4: Change Enablement)

### Purpose
Control the lifecycle of all changes to minimise risk of disrupting services while enabling beneficial changes.

### Change types
- Standard change — pre-authorised, low risk, well understood, documented procedure. No change approval needed each time.
- Normal change — requires assessment, authorisation, scheduling. Goes through change advisory board (CAB) or equivalent.
- Emergency change — must be implemented urgently. Expedited assessment, may be authorised by reduced authority. Documented after the fact.

### Change lifecycle
Raise RFC (Request for Change) → assess and evaluate → authorise → plan → implement → review and close.

### Key principles for Aria
- Every change to a customer environment is a Normal change unless pre-approved as Standard
- Discovery before implementation — understand current state first
- One change at a time — no batching without explicit approval
- Rollback plan required before implementation
- Post-implementation review mandatory

---

## Incident Management (ITIL 4: Incident Management)

### Purpose
Restore normal service operation as quickly as possible and minimise adverse impact.

### Incident lifecycle
Identify → log → categorise → prioritise → diagnose → escalate (if needed) → resolve → close.

### Priority matrix
Impact × Urgency = Priority. P1 (critical) → 15 min response, 4hr resolution target. P2 (high) → 1hr response, 8hr resolution. P3 (medium) → 4hr response, 24hr resolution. P4 (low) → 8hr response, 72hr resolution.

### Major incident
Declared when P1 incident affects multiple users or critical systems. Requires dedicated incident manager, regular updates to stakeholders, post-incident review (PIR) within 5 days.

---

## Problem Management (ITIL 4: Problem Management)

### Purpose
Reduce likelihood and impact of incidents by identifying root causes and implementing permanent fixes.

### Problem vs Incident
Incident: a disruption to service. Problem: the underlying cause of one or more incidents.

### Problem lifecycle
Problem identification → logging → categorisation → prioritisation → investigation and diagnosis → known error (workaround identified) → resolution → closure.

### Known Error Database (KEDB)
Documents known errors with workarounds. Used by incident management to resolve recurring incidents faster while permanent fix is in progress.
