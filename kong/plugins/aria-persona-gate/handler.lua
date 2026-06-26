-- aria-persona-gate.lua
-- Kong custom plugin — enforces persona routing before any upstream request.
-- Runs AFTER JWT validation plugin has verified the token.
-- Injects X-Aria-Jwt-Claims and X-Aria-Modules headers for aria-intake.
-- Blocks prvis Internal access unless BOTH KC role AND email gates pass.

local cjson  = require "cjson"
local plugin = {}

plugin.PRIORITY = 800  -- after JWT validator (900), before request reaches upstream
plugin.VERSION  = "1.0.0"

-- Internal allowed emails — must match ARIA_INTERNAL_ALLOWED_EMAILS env var
-- Kong reads from environment at startup
local function get_internal_emails()
  local raw = os.getenv("ARIA_INTERNAL_ALLOWED_EMAILS") or "vikas@prvis.com,contact@prvis.com"
  local emails = {}
  for email in raw:gmatch("[^,]+") do
    emails[email:lower():match("^%s*(.-)%s*$")] = true
  end
  return emails
end

local INTERNAL_EMAILS = get_internal_emails()
local INTERNAL_ROLE   = "prvis_internal"

function plugin:access(config)
  -- JWT claims are set by the JWT validator plugin as kong.ctx.shared.jwt_claims
  -- If not present — unauthenticated (marketing persona path)
  local claims = kong.ctx.shared.jwt_claims

  local persona    = "marketing"
  local modules    = ""
  local write_mode = "false"
  local ot_env     = "false"
  local allowed    = true
  local deny_reason = nil

  if claims then
    local email   = (claims.email or ""):lower()
    local roles   = {}
    if claims.realm_access and claims.realm_access.roles then
      for _, r in ipairs(claims.realm_access.roles) do
        roles[r] = true
      end
    end

    local has_internal_role  = roles[INTERNAL_ROLE] == true
    local has_internal_email = INTERNAL_EMAILS[email] == true

    -- prvis Internal double gate
    if has_internal_role and has_internal_email then
      persona    = "prvis_internal"
      write_mode = "true"

    elseif has_internal_role and not has_internal_email then
      -- Role without email — hard block, log
      kong.log.crit("SECURITY: prvis_internal role without email allowlist — email=" ..
                    email:sub(1,4) .. "*** route=" .. (kong.request.get_path() or "?"))
      allowed     = false
      deny_reason = "internal_role_without_email"

    elseif has_internal_email and not has_internal_role then
      -- Email without role — hard block, log
      kong.log.crit("SECURITY: internal allowlist email without prvis_internal role — email=" ..
                    email:sub(1,4) .. "*** route=" .. (kong.request.get_path() or "?"))
      allowed     = false
      deny_reason = "internal_email_without_role"

    else
      -- Regular authenticated customer
      local prvis_modules = claims.prvis_modules or ""
      if prvis_modules == "" then
        -- No modules — block, return 402
        allowed     = false
        deny_reason = "no_modules_licensed"
      else
        persona    = "security_engineer"
        modules    = prvis_modules
        write_mode = tostring(claims.aria_write_mode == "true")
        ot_env     = tostring(claims.aria_ot_environment == "true")
      end
    end
  end

  -- Hard block
  if not allowed then
    local status = deny_reason == "no_modules_licensed" and 402 or 403
    local body   = cjson.encode({error = deny_reason})
    return kong.response.exit(status, body, {["Content-Type"] = "application/json"})
  end

  -- Inject resolved claims as headers for aria-intake
  -- Claims are already verified — aria-intake trusts these headers
  kong.service.request.set_header("X-Aria-Persona",    persona)
  kong.service.request.set_header("X-Aria-Modules",    modules)
  kong.service.request.set_header("X-Aria-Write-Mode", write_mode)
  kong.service.request.set_header("X-Aria-Ot-Env",     ot_env)

  -- Pass JWT claims as JSON header for aria-intake to build CiD
  if claims then
    local ok, encoded = pcall(cjson.encode, claims)
    if ok then
      kong.service.request.set_header("X-Aria-Jwt-Claims", encoded)
    end
  end
end

return plugin
