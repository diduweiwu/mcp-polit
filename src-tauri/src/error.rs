//! 统一错误类型：所有 tauri command 的错误出口，可序列化传给前端。

use serde::Serialize;

/// 应用统一错误。
///
/// - 实现 `Serialize`，前端收到的形态为 `{ message: string }`。
/// - 展示给用户前已经过脱敏：不携带 header/env 等敏感内容。
#[derive(Debug, thiserror::Error)]
#[error("{message}")]
pub struct AppError {
    /// 人类可读的错误信息（中文）
    pub message: String,
}

impl AppError {
    /// 用一段中文信息构造错误。
    ///
    /// # 示例
    ///
    /// ```text
    /// let err = AppError::new("项目不存在");
    /// assert_eq!(err.message, "项目不存在");
    /// ```
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// 构造「未配置同步仓库」的错误（供 `ok_or_else` 使用）。
    pub fn new_sync_repo() -> Self {
        Self::new("尚未配置同步仓库路径，请先在「设置 → 同步」中填写")
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.message)
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(e: rusqlite::Error) -> Self {
        Self::new(format!("数据库操作失败：{e}"))
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        Self::new(format!("本地 IO 失败：{e}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        Self::new(format!("JSON 解析失败：{e}"))
    }
}

/// command 返回值统一别名。
pub type CmdResult<T> = Result<T, AppError>;
