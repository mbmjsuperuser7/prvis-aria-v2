# SOC 2 — Service Organisation Control 2

## What it is
SOC 2 is an auditing standard developed by AICPA for service organisations. It evaluates controls relevant to security, availability, processing integrity, confidentiality, and privacy of customer data. Two types: SOC 2 Type I (point in time) and SOC 2 Type II (over a period, typically 6-12 months).

## Trust Service Criteria (TSC)
- CC — Common Criteria (Security) — mandatory for all SOC 2 reports
- A — Availability
- PI — Processing Integrity
- C — Confidentiality
- P — Privacy

## Common Criteria categories
- CC1 — Control environment
- CC2 — Communication and information
- CC3 — Risk assessment
- CC4 — Monitoring activities
- CC5 — Control activities
- CC6 — Logical and physical access controls
- CC7 — System operations
- CC8 — Change management
- CC9 — Risk mitigation

## Controls most relevant to Aria customers
- CC6.1 — Logical access security — role-based access, least privilege, MFA
- CC6.2 — Prior to issuing credentials — user registration, credential provisioning
- CC6.3 — Role-based access and least privilege
- CC6.6 — Logical access from outside — remote access controls, VPN, zero trust
- CC6.7 — Transmission of data — encryption in transit
- CC7.1 — Detection and monitoring — vulnerability scans, IDS, SIEM
- CC7.2 — Monitoring for anomalies — alerting, log review
- CC8.1 — Change management — authorised, tested, documented changes

## Audit process
Readiness assessment → gap remediation → select auditor → audit period (Type II: 6-12 months) → auditor fieldwork → report issued → share with customers under NDA.

## Difference from ISO 27001
SOC 2 is an audit report attesting to controls at a point in time or over a period. ISO 27001 is a certification of a management system. SOC 2 is US-centric; ISO 27001 is international. Many organisations pursue both.
