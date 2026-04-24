# Agent service: Mastra + Playwright MCP + headed Chromium under Xvfb
# VNC (:5900) is exposed inside the agent-net so the browser-viewer sidecar can proxy it to noVNC (:6080).
FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright \
    DISPLAY=:99 \
    PATH=/usr/local/bin:$PATH

# System deps:
#   - xvfb + x11vnc + fluxbox : headed browser display + VNC feed + minimal WM
#   - tini                    : proper signal handling
#   - socat                   : handy for debugging port bridges
#   - ca-certificates, curl   : TLS + health probes
#   - python3, build-essential: native deps for some npm modules / utility scripts
#   - git                     : for any git-based dev workflows inside the container
RUN apt-get update && apt-get install -y --no-install-recommends \
      tini socat ca-certificates curl git \
      python3 python3-pip build-essential \
      xvfb x11vnc fluxbox \
      fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright browsers + their OS deps (pulls chromium + libs)
RUN npx -y playwright@latest install --with-deps chromium

# Non-root user for running the browser (matches security posture in MASTER_PLAN)
RUN useradd -m -s /bin/bash -u 1001 agent \
    && mkdir -p /workspace /home/agent/.vnc \
    && chown -R agent:agent /workspace /home/agent /opt/ms-playwright

WORKDIR /workspace

# Dev-container mode: keep the container alive, let VS Code attach and run commands.
# Production entrypoint (real start.sh launching Xvfb + x11vnc + node) lands in Week 1.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash", "-lc", "sleep infinity"]
