# ansai in the cloud: the web app plus claude, codex and agy, behind a KOOMPI ID (or password) sign-in.
# Runs as a non-root user that can still install software: Homebrew (brew install …), npm -g, pip --user, uv, bun.
#   docker build -f cloud/Dockerfile -t ansai-cloud .
#   docker run -p 8080:8080 -e GATE_PASSWORD=… ansai-cloud        (KOOMPI Cloud: add_koompi_login + ALLOWED)
FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8 TZ=Asia/Phnom_Penh
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git tmux tini procps less nano vim-tiny openssh-client unzip zip xz-utils file jq ripgrep \
      build-essential python3 python3-pip python3-venv nodejs npm locales tzdata \
    && rm -rf /var/lib/apt/lists/*

# Agents and runtimes live outside $HOME, so a disk mounted on /home/ansai later doesn't hide them.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash && bun --version
RUN npm install -g @openai/codex && npm cache clean --force && codex --version
RUN curl -fsSL https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh
RUN export HOME=/tmp/b && curl -fsSL https://claude.ai/install.sh | bash \
    && install -m 755 "$(readlink -f /tmp/b/.local/bin/claude)" /usr/local/bin/claude && rm -rf /tmp/b && claude --version
RUN export HOME=/tmp/b && curl -fsSL https://antigravity.google/cli/install.sh | bash \
    && install -m 755 "$(readlink -f /tmp/b/.local/bin/agy)" /usr/local/bin/agy && rm -rf /tmp/b && agy --version

# The user. KOOMPI Cloud runs images under a random uid in group 0, so everything the user owns is group-0 writable.
RUN useradd -m -u 1000 -g 0 -d /home/ansai -s /bin/bash ansai \
    && mkdir -p /home/linuxbrew/.linuxbrew && chown -R 1000:0 /home/linuxbrew \
    && chmod 666 /etc/passwd
USER 1000
RUN git clone -q --depth 1 https://github.com/Homebrew/brew /home/linuxbrew/.linuxbrew/Homebrew \
    && mkdir -p /home/linuxbrew/.linuxbrew/bin && ln -s ../Homebrew/bin/brew /home/linuxbrew/.linuxbrew/bin/brew \
    && HOMEBREW_NO_ANALYTICS=1 /home/linuxbrew/.linuxbrew/bin/brew --version
USER root

COPY --chown=1000:0 . /opt/ansai
RUN cd /opt/ansai && bun install --frozen-lockfile \
    && install -m 755 cloud/run.sh /usr/local/bin/ansai-cloud \
    && install -m 644 cloud/profile.sh /etc/profile.d/ansai-cloud.sh && echo '. /etc/profile.d/ansai-cloud.sh' >> /home/ansai/.bashrc \
    && mkdir -p /home/ansai/projects /home/ansai/.local/bin \
    && chown -R 1000:0 /home/ansai /opt/ansai && chmod -R g=u /home/ansai /home/linuxbrew /opt/ansai

ENV HOME=/home/ansai PATH=/home/ansai/.local/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/bin:/usr/bin:/bin \
    HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 \
    NPM_CONFIG_PREFIX=/home/ansai/.local PIP_USER=1 PIP_BREAK_SYSTEM_PACKAGES=1 DISABLE_AUTOUPDATER=1 \
    EDITOR=nano SHELL=/bin/bash
USER 1000
WORKDIR /home/ansai
EXPOSE 8080
ENTRYPOINT ["tini", "-s", "--", "/usr/local/bin/ansai-cloud"]
