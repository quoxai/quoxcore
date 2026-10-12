#!/bin/sh
# Copy SSH keys from staging mount to quox home with correct ownership
if [ -d /tmp/ssh-keys ] && [ "$(ls -A /tmp/ssh-keys 2>/dev/null)" ]; then
    cp -f /tmp/ssh-keys/* /home/quox/.ssh/ 2>/dev/null
    chown -R quox:quox /home/quox/.ssh
    chmod 700 /home/quox/.ssh
    chmod 600 /home/quox/.ssh/id_* 2>/dev/null
    chmod 644 /home/quox/.ssh/config 2>/dev/null
    chmod 644 /home/quox/.ssh/known_hosts 2>/dev/null
fi

# TOOLSMITH-E-fix-3.4: gosu does NOT inherit container-level group_add supplementary
# groups — it sets supplementary groups from /etc/group entries for the target user.
# scriptExecutor (dockerode) needs the docker socket group on user `quox`. Add the
# host's docker GID as a group named `dockerhost` and make quox a member at boot.
if [ -S /var/run/docker.sock ]; then
    DOCKER_SOCK_GID=$(stat -c '%g' /var/run/docker.sock 2>/dev/null || echo "")
    if [ -n "$DOCKER_SOCK_GID" ] && [ "$DOCKER_SOCK_GID" != "0" ]; then
        if ! getent group "$DOCKER_SOCK_GID" > /dev/null 2>&1; then
            groupadd -g "$DOCKER_SOCK_GID" dockerhost || true
        fi
        DOCKER_GROUP_NAME=$(getent group "$DOCKER_SOCK_GID" | cut -d: -f1)
        if [ -n "$DOCKER_GROUP_NAME" ] && id -nG quox | grep -qvw "$DOCKER_GROUP_NAME"; then
            usermod -aG "$DOCKER_GROUP_NAME" quox || true
        fi
    fi
fi

exec gosu quox "$@"
