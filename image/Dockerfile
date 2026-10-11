# dsh-computer — a stateful Linux "computer" in a container.
#
# Design notes:
#  - Debian (glibc + apt) rather than Alpine: many prebuilt agent tools
#    (Playwright browsers, native node modules) ship glibc binaries.
#  - The container user is uid 1000 to match the host `node` user, so files in
#    the bind-mounted home come back writable by the agent's own file tools.
#  - That user has passwordless sudo, so the box can grow itself at runtime.
#    The image is a starting point, not a fixed toolset.
#  - DISPLAY is set via ENV so it survives into `docker exec` sessions.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    SCREEN_GEOMETRY=1440x900x24 \
    LANG=C.UTF-8

RUN apt-get update && apt-get install -y --no-install-recommends \
      bash coreutils procps findutils grep sed gawk \
      curl wget git jq ripgrep ca-certificates xz-utils unzip \
      python3 python3-venv python3-pip \
      nodejs npm \
      xvfb x11-utils x11-xserver-utils xdotool imagemagick scrot \
      chromium openbox xterm fonts-liberation fonts-dejavu-core fonts-noto-cjk \
      x11vnc novnc websockify \
      sudo less nano \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 matches the host user that owns the bind mount.
RUN useradd -m -u 1000 -s /bin/bash agent \
 && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent \
 && chmod 0440 /etc/sudoers.d/agent \
 && mkdir -p /home/agent/_shots \
 && chown -R agent:agent /home/agent

# NOTE: `chmod +x` is wrong here. The build context file is mode 600, and
# `chmod +x` yields 711 — executable but NOT readable by group/other. A shebang
# script must be readable to exec, so the container dies with exit 126
# ("Permission denied"). Set the mode explicitly.
COPY entrypoint.sh /entrypoint.sh
COPY box-chrome.sh /usr/local/bin/box-chrome
COPY box-desktop.sh /usr/local/bin/box-desktop
RUN chmod 755 /entrypoint.sh /usr/local/bin/box-chrome /usr/local/bin/box-desktop

USER agent
WORKDIR /home/agent

ENTRYPOINT ["/entrypoint.sh"]
