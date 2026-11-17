//! 运行时诊断：panic 与进程退出事件的本地留痕。
//!
//! 背景：macOS 上 Rust panic（unwind 退出，exit code 101）**不会**生成系统
//! 崩溃报告（.ips），进程"闪退"后在 ~/Library/Logs/DiagnosticReports 里无迹
//! 可查。本模块把 panic 信息与退出事件追加写入应用数据目录下的 crash.log，
//! 用于事后定位闪退原因。
//!
//! 隐私：日志仅落在本机应用数据目录，不联网上传；内容只含 panic 消息、
//! 代码位置与调用栈，不含业务数据。

use std::fs::OpenOptions;
use std::io::Write;
use std::panic;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 单个日志文件上限：超过后直接重建，避免无限增长。
const MAX_LOG_BYTES: u64 = 2 * 1024 * 1024;

/// 诊断日志句柄：crash.log 的路径，托管到 Tauri state 供退出事件写入。
///
/// # 示例
///
/// ```text
/// app.manage(DiagLog(data_dir.join("crash.log")));
/// let log = app.state::<DiagLog>();
/// append_diag(&log.0, "EXIT", "进程退出");
/// ```
pub struct DiagLog(pub PathBuf);

/// 安装全局 panic 钩子：panic 发生时把消息、代码位置与调用栈追加进日志。
///
/// 应在应用启动早期（setup 中）调用一次；重复调用会覆盖前一个钩子。
/// 同时保留 stderr 输出，便于 `cargo run` 时在终端直接观察。
///
/// # 参数
///
/// - `log_path`: 日志文件完整路径（所在目录需已存在）。
pub fn install_panic_logger(log_path: PathBuf) {
    panic::set_hook(Box::new(move |info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            (*s).to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "未知 panic payload".to_string()
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "未知位置".to_string());
        let bt = std::backtrace::Backtrace::force_capture().to_string();
        append_diag(&log_path, "PANIC", &format!("{msg}\n  位置: {loc}\n{bt}"));
        eprintln!("PANIC: {msg}（{loc}）");
    }));
}

/// 追加一行诊断日志：`[UTC 时间] [类别] 内容`。
///
/// 写入失败静默忽略（诊断日志本身绝不能反过来把进程搞挂）。
///
/// # 参数
///
/// - `path`: 日志文件路径
/// - `kind`: 事件类别，如 `PANIC` / `EXIT`
/// - `message`: 日志内容（可含换行）
pub fn append_diag(path: &Path, kind: &str, message: &str) {
    // 超限重建：诊断日志重头开始也无关紧要，最新的几条才关键
    if let Ok(meta) = std::fs::metadata(path) {
        if meta.len() > MAX_LOG_BYTES {
            let _ = std::fs::remove_file(path);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "[{}] [{}] {}", iso_utc_now_ms(), kind, message);
    }
}

/// 当前时刻的 UTC ISO-8601 字符串，如 `"2026-11-17T07:12:34.123Z"`。
///
/// std 无本地时区 API，诊断日志统一用 UTC 并显式标注 `Z`，
/// 与用户本地时间差即时区偏移（如 UTC+8 需自行 +8h 对照）。
fn iso_utc_now_ms() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let ms = now.subsec_millis();
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        y,
        m,
        d,
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60,
        ms
    )
}

/// 自 1970-01-01 起的天数转公历日期（Howard Hinnant `civil_from_days` 算法）。
///
/// # 参数
///
/// - `z`: 天数，可为负（1970 年之前）。
///
/// # 返回
///
/// `(年, 月, 日)` 三元组，月/日为 1 起始。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 公历换算锚点：已知日期不得算错（含闰年与纪元边界）。
    #[test]
    fn civil_from_days_锚点日期() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        // 2024-02-29（闰日）= 19782 天
        assert_eq!(civil_from_days(19_782), (2024, 2, 29));
        // 2026-11-17 = 20774 天
        assert_eq!(civil_from_days(20_774), (2026, 11, 17));
    }
}
