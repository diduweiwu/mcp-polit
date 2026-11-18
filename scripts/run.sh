#!/usr/bin/env bash
# MCPilot 打包并在本地运行
#
# 用法：
#   ./scripts/run.sh            # release 打包后运行产物
#   ./scripts/run.sh --dev      # 跳过打包，直接进入开发模式（热更新）
#   ./scripts/run.sh --run      # 快速调试：增量编译 debug 版 app 并直跑（连 vite 热更新，窗口秒开）
#   ./scripts/run.sh --demo     # 浏览器演示模式：只起 Vite + 自动开浏览器（免编译 Rust，内置 mock 数据）
#   ./scripts/run.sh --build-only  # 只打包不运行
#
# 产物位置：src-tauri/target/release/bundle/
#   macOS   -> macos/MCPilot.app（dmg 在 dmg/ 下）
#   Linux   -> appimage/*.AppImage、deb/、rpm/
#   Windows -> nsis/*.exe、msi/*.msi
set -euo pipefail
cd "$(dirname "$0")/.."

# cargo 不一定在非交互 shell 的 PATH 里（~/.zshrc 的 PATH 配置只对交互 shell 生效）
[ -d "$HOME/.cargo/bin" ] && export PATH="$HOME/.cargo/bin:$PATH"

MODE="release"
RUN_AFTER_BUILD=1
for arg in "$@"; do
  case "$arg" in
    --dev) MODE="dev" ;;
    --run) MODE="run" ;;
    --demo) MODE="demo" ;;
    --build-only) RUN_AFTER_BUILD=0 ;;
    *) echo "未知参数：$arg（支持 --dev / --run / --demo / --build-only）"; exit 1 ;;
  esac
done

# 在线更新签名（tauri.conf.json 开了 createUpdaterArtifacts，release 打包必需）：
# 本地用 tauri signer generate 生成的私钥文件；CI 由 GitHub Secrets 提供同名变量。
# 私钥无密码，PASSWORD 显式置空，避免误读到环境里残留的值。
if [ -f "$HOME/.tauri/mcpilot.key" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/mcpilot.key"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
fi

# dev 模式：直接交给 tauri dev（Ctrl+C 退出）
if [ "$MODE" = "dev" ]; then
  echo "==> 开发模式（热更新）"
  pnpm tauri dev
  exit 0
fi

# 直跑模式：增量编译 debug 版 app 并直接运行（不打包 bundle、不经 tauri dev 托管）。
# debug 构建（无 custom-protocol feature）即为 dev 模式：app 内嵌 devUrl 直连 vite，
# 改前端代码经 HMR 即时生效在 app 窗口内；只有改 Rust 代码才需要重新增量编译。
# 首次需完整编译一次，之后日常秒开。
if [ "$MODE" = "run" ]; then
  echo "==> 快速调试模式：增量编译 debug 版 app 并直跑"
  # Cargo.toml 在 src-tauri/ 子目录，用 manifest-path 指定（脚本 cwd 保持项目根）
  cargo build --manifest-path src-tauri/Cargo.toml
  BIN="src-tauri/target/debug/mcpilot"
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) BIN="src-tauri/target/debug/mcpilot.exe" ;;
  esac
  if [ ! -x "$BIN" ]; then
    echo "!! 未找到 debug 二进制：$BIN"
    exit 1
  fi
  # 确保 vite dev server 在跑（app 直连 1420；已有则复用，没有则后台起并在退出时清理）
  if ! lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
    # 直跑 vite 的 node 入口（不经 pnpm）：进程树只有一层，kill 一个即全灭不留孤儿
    node node_modules/vite/bin/vite.js &
    VITE_PID=$!
    trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do
      if curl -sf -o /dev/null "http://localhost:1420"; then break; fi
      sleep 0.5
    done
  fi
  echo "==> 启动 ${BIN}（关闭窗口即退出；前端改动经 vite HMR 即时生效）"
  "$BIN"
  exit 0
fi

# 浏览器演示模式：只起 Vite dev server + 自动开浏览器，不编译 Rust（UI 预览最快路径）。
# 演示模式带内置 mock 数据（见 src/dev-mock.ts，仅 DEV 构建生效）
if [ "$MODE" = "demo" ]; then
  echo "==> 浏览器演示模式（免编译 Rust；Ctrl+C 退出并关闭 dev server）"
  # 1420 已有 dev server 在跑（比如之前 --demo 没退）：复用，直接开浏览器
  if lsof -nP -iTCP:1420 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "==> 1420 端口已有 dev server，直接复用"
    open "http://localhost:1420"
    exit 0
  fi
  # 直跑 vite 的 node 入口（不经 pnpm）：进程树只有一层，退出时 kill 一个即全灭，
  # 不会留下孤儿 dev server 占住 1420（实测 pnpm 不转发信号给 vite 子进程）
  node node_modules/vite/bin/vite.js &
  VITE_PID=$!
  # 退出（含 Ctrl+C）时回收 dev server，防孤儿进程占住 1420
  trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT
  # 等待 dev server 就绪（最多约 30 秒）
  for _ in $(seq 1 60); do
    if curl -sf -o /dev/null "http://localhost:1420"; then break; fi
    sleep 0.5
  done
  open "http://localhost:1420"
  echo "==> 浏览器已打开 http://localhost:1420（演示模式，内置 mock 数据，仅用于 UI 预览）"
  wait "$VITE_PID"
  exit 0
fi

echo "==> Release 打包（首次需数分钟）"
pnpm tauri build

echo "==> 打包完成，产物："
find src-tauri/target/release/bundle -maxdepth 2 -type f \( -name "*.dmg" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" -o -name "*.exe" -o -name "*.msi" \) 2>/dev/null | sed 's/^/    /'
echo "    src-tauri/target/release/bundle/macos/MCPilot.app"

# 按平台运行打包产物
if [ "$RUN_AFTER_BUILD" -ne 1 ]; then
  echo "==> 已跳过运行（--build-only）"
  exit 0
fi

OS="$(uname -s)"
case "$OS" in
  Darwin)
    APP="src-tauri/target/release/bundle/macos/MCPilot.app"
    echo "==> 启动 $APP"
    open "$APP"
    ;;
  Linux)
    APPIMAGE=$(find src-tauri/target/release/bundle/appimage -name "*.AppImage" 2>/dev/null | head -1)
    if [ -n "$APPIMAGE" ]; then
      echo "==> 启动 $APPIMAGE"
      chmod +x "$APPIMAGE"
      nohup "$APPIMAGE" >/dev/null 2>&1 &
    else
      echo "!! 未找到 AppImage，可运行 deb/rpm 安装后的 mcpilot 命令"
      exit 1
    fi
    ;;
  MINGW* | MSYS* | CYGWIN*)
    echo "==> Windows 下请运行打包产物中的 NSIS 安装包："
    find src-tauri/target/release/bundle/nsis -name "*.exe" 2>/dev/null | sed 's/^/    /'
    ;;
  *)
    echo "!! 未知平台：$OS"
    exit 1
    ;;
esac
echo "==> 完成"
