FROM debian:bookworm-slim

RUN dpkg --add-architecture arm64 && \
    apt-get update && apt-get install -y \
    gcc-aarch64-linux-gnu \
    g++-aarch64-linux-gnu \
    make \
    libpipewire-0.3-dev:arm64 \
    libspa-0.2-dev:arm64 \
    pkg-config \
    git \
    meson \
    ninja-build \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Meson cross-file per aarch64
RUN echo '[binaries]'                           >  /opt/aarch64-cross.txt && \
    echo "c = 'aarch64-linux-gnu-gcc'"          >> /opt/aarch64-cross.txt && \
    echo "cpp = 'aarch64-linux-gnu-g++'"        >> /opt/aarch64-cross.txt && \
    echo "ar = 'aarch64-linux-gnu-ar'"          >> /opt/aarch64-cross.txt && \
    echo "strip = 'aarch64-linux-gnu-strip'"    >> /opt/aarch64-cross.txt && \
    echo ''                                     >> /opt/aarch64-cross.txt && \
    echo '[host_machine]'                       >> /opt/aarch64-cross.txt && \
    echo "system = 'linux'"                     >> /opt/aarch64-cross.txt && \
    echo "cpu_family = 'aarch64'"               >> /opt/aarch64-cross.txt && \
    echo "cpu = 'aarch64'"                      >> /opt/aarch64-cross.txt && \
    echo "endian = 'little'"                    >> /opt/aarch64-cross.txt && \
    echo ''                                     >> /opt/aarch64-cross.txt && \
    echo '[properties]'                         >> /opt/aarch64-cross.txt && \
    echo 'needs_exe_wrapper = true'             >> /opt/aarch64-cross.txt

# Rubber Band Library — build statico arm64 (R2 engine, FFT e resampler built-in)
RUN git clone --depth=1 https://github.com/breakfastquay/rubberband.git /opt/rubberband && \
    cd /opt/rubberband && \
    meson setup build-arm64 \
        --cross-file /opt/aarch64-cross.txt \
        --buildtype=release \
        --default-library=static \
        -Dfft=builtin \
        -Dresampler=builtin \
    && ninja -C build-arm64

ENV CROSS_PREFIX=aarch64-linux-gnu-
ENV PKG_CONFIG_PATH=/usr/lib/aarch64-linux-gnu/pkgconfig
ENV PKG_CONFIG_LIBDIR=/usr/lib/aarch64-linux-gnu/pkgconfig
ENV PKG_CONFIG_SYSROOT_DIR=/
WORKDIR /build
