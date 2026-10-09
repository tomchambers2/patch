#!/usr/bin/env bash
# Provision encrypted native credential storage for Codex on a headless Ubuntu host.
# The unlock password is generated into systemd's encrypted credential store;
# it is never written as plaintext or printed. The service reads it via systemd.
set -euo pipefail
if [ "$(uname -s)" != Linux ]; then echo 'This setup is for Linux hosts only.' >&2; exit 1; fi
patch_user=$(id -un)
patch_uid=$(id -u)
export DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${patch_uid}/bus"
patch_home=$(getent passwd "$patch_user" | cut -d: -f6)
if [ "$patch_uid" = 0 ]; then echo 'Run as the Patch daemon user, with sudo available.' >&2; exit 1; fi
sudo -n apt-get update -qq
sudo -n apt-get install -y -qq gnome-keyring libsecret-tools
sudo -n install -d -m 700 /etc/credstore.encrypted
if ! sudo -n test -f /etc/credstore.encrypted/patch-keyring; then
  python3 -c 'import secrets,sys; sys.stdout.write(secrets.token_urlsafe(48))' | sudo -n systemd-creds encrypt --with-key=host --name=keyring - /etc/credstore.encrypted/patch-keyring
fi
if sudo -n test -f /etc/systemd/system/patch-keyring.service; then
  echo 'Patch keyring service is already configured.'
else
  sudo -n tee /etc/systemd/system/patch-keyring.service >/dev/null <<UNIT
[Unit]
Description=Patch native encrypted credential store
After=user@${patch_uid}.service
Requires=user@${patch_uid}.service

[Service]
Type=simple
User=${patch_user}
Environment=HOME=${patch_home}
Environment=XDG_RUNTIME_DIR=/run/user/${patch_uid}
Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${patch_uid}/bus
LoadCredentialEncrypted=keyring:/etc/credstore.encrypted/patch-keyring
ExecStart=/bin/sh -c 'exec /usr/bin/gnome-keyring-daemon --foreground --unlock --components=secrets < "\$CREDENTIALS_DIRECTORY/keyring"'
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now patch-keyring.service
fi
sudo -n systemctl is-active --quiet patch-keyring.service
printf 'patch-keyring-probe' | secret-tool store --label='Patch storage verification' service patch-storage-probe
probe=$(secret-tool lookup service patch-storage-probe)
[ "$probe" = patch-keyring-probe ]
secret-tool clear service patch-storage-probe
echo 'Native encrypted credential storage verified.'
