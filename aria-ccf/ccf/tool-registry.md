# Aria — Tool Registry

## Execution environment

The sandbox is an ephemeral Docker container provisioned per conversation (CiD-scoped).
Commands run directly inside it via tool=shell — never SSH to the sandbox itself.
Sandbox has full outbound internet access.

## Toolkit available in sandbox

### Network — discovery and diagnostics ONLY
- curl, wget — single HTTP requests with full header/method/body control
- httpie (http) — human-friendly single HTTP requests
- nmap — HOST DISCOVERY AND SPECIFIC PORT CHECKS ONLY
  Allowed: `nmap -sn 192.168.1.0/24` (ping sweep)
           `nmap -p 22,80,443 specific-host` (check known ports on one host)
  NOT allowed: aggressive rate flags, SYN scans, version detection sweeps
- netcat — single TCP/UDP connection tests
- dig, whois, ping, tracepath — DNS and network diagnostics
- openssl s_client — TLS/certificate inspection on a specific host
- iproute2, net-tools — local network interface info

### API verification (user's own systems only)
- curl — send specific requests, inspect responses, check headers
- httpie — readable HTTP request/response inspection
- openssl — verify TLS config and certificate chain
- newman — run user-supplied Postman collection against user's own API

### What we check manually with curl/httpie:
- Security headers present: HSTS, X-Frame-Options, CSP, X-Content-Type-Options
- CORS policy: is Access-Control-Allow-Origin overly permissive?
- Error verbosity: do 4xx/5xx responses leak stack traces or internal paths?
- Authentication: are protected endpoints actually protected?
- TLS: valid cert, no deprecated TLS 1.0/1.1, strong ciphers

### NOT in sandbox — offensive/scanning tools
nuclei, ffuf, masscan, sqlmap, metasploit, nikto — NOT installed.
These are attack tools. Scanning someone else's infrastructure without
permission is illegal. Even on customer's own infra, automated scanners
must be used with explicit scope definition and rate limits.

### Dev and scripting
- python3 + requests, httpx, paramiko, netmiko, cryptography, pandas
- bash, node.js, git
- ansible-core for multi-host operations
- jq, yq — JSON/YAML parsing
- postgresql-client, redis-cli

## Tool routing

| Tool       | Underlying system | Write required |
|------------|-------------------|----------------|
| shell      | sandbox toolkit   | depends        |
| ssh_exec   | Guacamole → SSH   | yes            |
| http_get   | sandbox curl      | no             |
| http_post  | sandbox curl      | yes            |
| python     | sandbox python3   | depends        |
| web_search | Tavily API        | no             |
| vm_list    | Proxmox API       | no             |
| vm_create  | Proxmox API       | yes            |
| edr_alerts | Wazuh API         | no             |
| mdm_devices| FleetDM API       | no             |
| vuln_findings | DefectDojo API | no             |
| soc_cases  | TheHive API       | no             |

## Nmap usage rules (CRITICAL)

nmap is available for discovery tasks only:
- Ping sweep to check host up/down: `nmap -sn <range>`
- Check specific known ports on a specific host: `nmap -p <ports> <host>`
- IP to hostname mapping: `nmap -sn --dns-servers <dns> <range>`

nmap MUST NOT be used with:
- Aggressive rate flags (--min-rate, -T4, -T5)
- SYN scan (-sS) — requires root, also aggressive
- Service/version detection sweep (-sV) across multiple hosts
- OS detection (-O) across ranges
- Scripts that probe for vulnerabilities (-sC, --script vuln)

If a user asks for a "full port scan" or "vulnerability scan" — clarify scope,
confirm it is their own infrastructure, and use targeted specific-port checks
rather than broad sweeps.
