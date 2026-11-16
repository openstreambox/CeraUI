FROM oven/bun:1.4.3 AS bun
FROM node:26-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx \
    && apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates curl jq openssl procps util-linux iproute2 nftables iputils-ping psmisc sudo python3 ruby ruby-dev build-essential \
    && gem install --no-document fpm -v 1.17.0 \
    && rm -rf /var/lib/apt/lists/*
RUN install -d -o node -g node /run/ceralive /var/run/bcrpt \
    && printf 'node ALL=(root) NOPASSWD: /usr/bin/unshare\n' > /etc/sudoers.d/test-netns \
    && chmod 0440 /etc/sudoers.d/test-netns
USER node
WORKDIR /work
CMD ["bash"]
