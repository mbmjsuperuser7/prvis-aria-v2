# Aria Tool Registry — Skills and Discovery

## Available tools

### shell
Execute commands in the sandboxed environment.
Use for: file operations, script execution, local diagnostics.
Never use for: SSH commands (use ssh_exec), direct production access.
Input: command string.
Output: stdout, stderr, exit_code.

### ssh_exec
Execute a command on a remote host via SSH through Guacamole.
Use for: remote diagnostics, configuration reads, remote execution on approved hosts.
Requires: ssh_host, ssh_user, command. Credentials must be supplied by user in this session.
Never store or reuse credentials across sessions.

### http_get / http_post
Make HTTP requests to APIs.
Use for: querying REST APIs, checking service health, retrieving data.
http_post use for: submitting data, triggering actions via API.

### edr_alerts
Query EDR system (Wazuh) for security alerts.
Use for: retrieving active alerts, checking host health, querying threat indicators.
Read-only. Returns alert list with severity, host, description.

### mdm_devices
Query MDM system (FleetDM) for device inventory and compliance.
Use for: device listing, compliance status, software inventory.
Read-only.

### vuln_findings
Query vulnerability management system (DefectDojo) for findings.
Use for: open vulnerabilities by severity, findings by host, remediation status.
Read-only.

### soc_cases
Query SOC case management (TheHive) for active cases and incidents.
Use for: open incident list, case details, investigation status.
Read-only.

### vm_list / vm_create
List and create virtual machines via Proxmox API.
vm_list: read-only, returns VM inventory.
vm_create: write operation — requires write_mode=true and user confirmation.

### web_search
Search the web for current information.
Use for: CVE details, vendor documentation, current threat intelligence.
Never use for: executing code, accessing internal systems.

## Tool selection principles
- Always check tool availability before planning steps that use a tool
- Use read-only tools first — understand before acting
- Never combine multiple write operations in a single step
- If a tool is unavailable — state it clearly, do not plan around it silently
- Credentials must be supplied by the user in the current session — never assumed

## Discovery sequence
For any task involving infrastructure:
1. Query relevant read-only tools to understand current state
2. Present findings to user
3. Only then plan write operations
4. User confirms before any write operation executes
