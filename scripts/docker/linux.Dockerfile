# Pinned 2026-03-13. To update: docker pull node:22-bookworm && docker inspect --format='{{index .RepoDigests 0}}' node:22-bookworm
FROM node:22-bookworm@sha256:b501c082306a4f528bc4038cbf2fbb58095d583d0419a259b2114b5ac53d12e9

# Workaround for Rosetta x86_64 emulation causing apt hash mismatches
RUN echo 'Acquire::http::Pipeline-Depth "0";' > /etc/apt/apt.conf.d/99rosetta-fix && \
    echo 'Acquire::http::No-Cache=True;' >> /etc/apt/apt.conf.d/99rosetta-fix

# Install build dependencies for electron-builder and native modules.
# Native modules build with clang 19: Electron 44's V8 headers fail on
# bookworm's GCC 12 (`class [[deprecated]] __attribute__(...)`) and clang 14
# (no std::source_location). Bookworm's clang keeps the glibc/libstdc++ baseline.
RUN apt-get update && \
    apt-get install -y \
    build-essential \
    clang-19 \
    git \
    libx11-dev \
    libxkbfile-dev \
    libsecret-1-dev \
    rpm \
    fakeroot \
    dpkg \
    && rm -rf /var/lib/apt/lists/*

ENV CC=clang-19 CXX=clang++-19
