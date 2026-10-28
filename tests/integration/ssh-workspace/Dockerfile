FROM debian:13-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      iproute2 \
      novnc \
      openbox \
      openssh-server \
      python3 \
      rsync \
      tigervnc-standalone-server \
      tmux \
      websockify \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --shell /bin/bash komla \
    && passwd --delete komla \
    && install -d -m 0700 -o komla -g komla /home/komla/.ssh \
    && install -d -m 0755 /run/sshd \
    && git config --system user.name "Komla SSH Integration" \
    && git config --system user.email "ssh-integration@komla.test" \
    && printf '%s\n' \
      'PasswordAuthentication no' \
      'PermitRootLogin no' \
      'AllowTcpForwarding yes' \
      'GatewayPorts no' \
      >> /etc/ssh/sshd_config

EXPOSE 22

CMD ["/usr/sbin/sshd", "-D", "-e"]
