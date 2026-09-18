FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates python3 build-essential cmake ninja-build pkg-config \
    libx11-dev libxcb1-dev libegl1-mesa-dev libgles2-mesa-dev \
    libgl1-mesa-dri libegl-mesa0 mesa-utils xvfb xauth \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /project
CMD ["bash"]
