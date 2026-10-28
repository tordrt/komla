# SSH host for the landing videos: the SSH integration-test host plus Node,
# which runs the scripted agent and the demo dev servers on the host, and npm,
# which runs their tests.
FROM debian:13-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      iproute2 \
      nodejs \
      npm \
      openssh-server \
      procps \
      python3 \
      rsync \
      tmux \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash komla \
    && passwd --delete komla \
    && install -d -m 0700 -o komla -g komla /home/komla/.ssh \
    && install -d -m 0755 /run/sshd \
    && git config --system user.name "Komla" \
    && git config --system user.email "demo@komla.dev" \
    && git config --system safe.directory '*' \
    && printf '%s\n' \
      'PasswordAuthentication no' \
      'PermitRootLogin no' \
      'AllowTcpForwarding yes' \
      'GatewayPorts no' \
      >> /etc/ssh/sshd_config

COPY bashrc /tmp/video-bashrc
RUN cat /tmp/video-bashrc >> /home/komla/.bashrc && rm /tmp/video-bashrc

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
