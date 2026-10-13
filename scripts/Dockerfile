FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq git cmake make python3 xz-utils curl ca-certificates gawk bzip2 lbzip2 >/dev/null && rm -rf /var/lib/apt/lists/*
RUN git clone -q https://github.com/emscripten-core/emsdk.git /opt/emsdk && cd /opt/emsdk && ./emsdk install 4.0.18 >/dev/null && ./emsdk activate 4.0.18 >/dev/null
RUN curl -sSfL https://nodejs.org/dist/v24.15.0/node-v24.15.0-linux-x64.tar.xz | tar -xJ -C /opt && mkdir -p /opt/ts5 && cd /opt/ts5 && PATH=/opt/node-v24.15.0-linux-x64/bin:$PATH npm i --silent typescript@5.9
ENV PATH=/opt/ts5/node_modules/.bin:/opt/node-v24.15.0-linux-x64/bin:/opt/emsdk:/opt/emsdk/upstream/emscripten:$PATH EMSDK=/opt/emsdk EMSDK_NODE=/opt/emsdk/node/22.16.0_64bit/bin/node
RUN git config --global --add safe.directory '*' && bash -c "source /opt/emsdk/emsdk_env.sh && emcc --version | head -1 && ls /opt/emsdk/node"
