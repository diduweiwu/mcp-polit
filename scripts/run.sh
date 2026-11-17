#!/usr/bin/env bash
# MCPilot 打包并在本地运行
#
# 用法：
#   ./scripts/run.sh            # release 打包后运行产物
#   ./scripts/run.sh --dev      # 跳过打包，直接进入开发模式（热更新）
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
    --build-only) RUN_AFTER_BUILD=0 ;;
    *) echo "未知参数：$arg（支持 --dev / --build-only）"; exit 1 ;;
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
