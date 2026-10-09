# Web Bot Auth signing key (secret lives in 1Password Agents / env-patch).
# Render with: env-render deploy/web-bot-auth.env.tpl  ->  deploy/web-bot-auth.env
# Load it into the environment of BOTH the server (serves the key directory) and
# each host that should sign its browser requests, e.g. via systemd EnvironmentFile.
# A host signs only when it also has PATCH_WEB_BOT_AUTH=on (default off).
PATCH_WEB_BOT_AUTH_KEY={{ op://Agents/env-patch/PATCH_WEB_BOT_AUTH_KEY }}
