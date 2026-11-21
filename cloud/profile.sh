# ansai cloud: no root here, but you can install software:
#   brew install <pkg>     npm i -g <pkg>     pip install <pkg>     uv tool install <pkg>     bun add -g <pkg>
case ":$PATH:" in *":/home/linuxbrew/.linuxbrew/bin:"*) ;; *)
    export PATH="$HOME/.local/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:/usr/local/bin:$PATH" ;; esac
export HOMEBREW_PREFIX=/home/linuxbrew/.linuxbrew HOMEBREW_NO_ANALYTICS=1 HOMEBREW_NO_AUTO_UPDATE=1 \
    NPM_CONFIG_PREFIX="$HOME/.local" PIP_USER=1 PIP_BREAK_SYSTEM_PACKAGES=1 DISABLE_AUTOUPDATER=1
