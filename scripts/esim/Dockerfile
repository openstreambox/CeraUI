FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates git cmake gcc make libc6-dev libcurl4-openssl-dev python3 pkg-config libcriterion-dev \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/esim /recipe
RUN /recipe/build-lpac.sh /build/lpac
RUN mkdir -p /usr/libexec/ceralive \
    && cp -a /build/lpac/install /usr/libexec/ceralive/lpac \
    && LPAC_APDU=at_csim LPAC_HTTP=curl /usr/libexec/ceralive/lpac/bin/lpac version
FROM scratch AS artifacts
COPY --from=0 /build/lpac/install/ /lpac/
