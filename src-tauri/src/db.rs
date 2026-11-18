//! 数据库层：SQLite 初始化、迁移与全部 CRUD。
//!
//! 设计要点：
//! - 数据文件仅存放在系统应用数据目录（macOS: `~/Library/Application Support/MCPilot/`），
//!   绝不联网上传。
//! - 所有读写均使用 prepared statement（防 SQL 注入）。
//! - `tree_nodes` 采用扁平表 + `parent_id` 表达任意层级，树结构由前端组装。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

use crate::error::{AppError, CmdResult};
use crate::models::{
    CallResult, HistoryRecord, NodeType, Project, ServerConfig, TreeNode, TransportType,
};

/// 数据库访问句柄：内部包一把互斥锁，保证多线程串行访问 SQLite。
pub struct Db(pub Mutex<Connection>);

/// 打开（或创建）数据库并执行迁移。
///
/// # 参数
///
/// - `db_path`: 数据库文件的完整路径（父目录会被自动创建）。
///
/// # 返回
///
/// 已开启外键约束的 SQLite 连接。
///
/// # 异常
///
/// 父目录创建失败或 SQLite 打开/建表失败时返回 [`AppError`]。
pub fn init(db_path: &Path) -> Result<Connection, AppError> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

/// 执行建表迁移（幂等，全部使用 `IF NOT EXISTS`）。
fn migrate(conn: &Connection) -> Result<(), AppError> {
    conn.execute_batch(
        r#"
        BEGIN;

        -- 项目表：最顶层数据组织单位
        CREATE TABLE IF NOT EXISTS projects (
            -- 项目 ID：自增主键
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            -- 项目名称：左上角切换器中显示的名字，同一时刻名称不强制唯一
            name TEXT NOT NULL,
            -- 创建时间：本地时间，格式 YYYY-MM-DD HH:MM:SS
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            -- 更新时间：本地时间
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        -- 树节点表：目录与 MCP Server 统一存储，parent_id 表达嵌套层级
        CREATE TABLE IF NOT EXISTS tree_nodes (
            -- 节点 ID：自增主键
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            -- 所属项目 ID：外键 -> projects.id，项目删除时级联删除
            project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            -- 父节点 ID：外键 -> tree_nodes.id；NULL 表示位于项目根层
            parent_id INTEGER REFERENCES tree_nodes(id) ON DELETE CASCADE,
            -- 节点类型。枚举：folder-目录；server-MCP Server
            node_type TEXT NOT NULL CHECK (node_type IN ('folder','server')),
            -- 显示名称：目录为目录名；server 为用户设置的别名
            name TEXT NOT NULL,
            -- 同层排序序号：越小越靠前
            sort_order INTEGER NOT NULL DEFAULT 0,
            -- 创建时间：本地时间
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            -- 更新时间：本地时间
            updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );
        -- 常用查询索引：按项目取全量节点、按父节点取子节点
        CREATE INDEX IF NOT EXISTS idx_tree_nodes_project ON tree_nodes(project_id);
        CREATE INDEX IF NOT EXISTS idx_tree_nodes_parent ON tree_nodes(parent_id);

        -- MCP Server 连接配置表：与 server 类型节点 1:1
        CREATE TABLE IF NOT EXISTS server_configs (
            -- 节点 ID：主键，外键 -> tree_nodes.id，节点删除时级联删除
            node_id INTEGER PRIMARY KEY REFERENCES tree_nodes(id) ON DELETE CASCADE,
            -- 传输类型。枚举：stdio-本地子进程；streamable_http-远程 Streamable HTTP
            transport_type TEXT NOT NULL CHECK (transport_type IN ('stdio','streamable_http')),
            -- stdio 模式：启动命令，如 npx / uvx / node
            command TEXT,
            -- stdio 模式：命令参数，JSON 数组字符串，如 '["-y","server-xxx"]'
            args TEXT,
            -- stdio 模式：附加环境变量，JSON 对象字符串，如 '{"KEY":"VALUE"}'
            env TEXT,
            -- stdio 模式：子进程工作目录（可选）
            working_dir TEXT,
            -- streamable_http 模式：服务地址，如 http://127.0.0.1:3000/mcp
            url TEXT,
            -- streamable_http 模式：自定义请求头（含鉴权头），JSON 对象字符串
            headers TEXT,
            -- 工具调用超时时间：毫秒，默认 30000
            timeout_ms INTEGER NOT NULL DEFAULT 30000,
            -- 是否启用该 Server。枚举：0-停用；1-启用
            enabled INTEGER NOT NULL DEFAULT 1,
            -- 备注：用户自由填写（可选）
            note TEXT
        );

        -- 应用设置表：键值对（主题色、明暗模式、当前项目等）
        CREATE TABLE IF NOT EXISTS settings (
            -- 设置键：如 theme_color / theme_mode / active_project_id
            key TEXT PRIMARY KEY,
            -- 设置值：字符串（JSON/纯文本均可，由调用方解释）
            value TEXT NOT NULL
        );

        -- 工具调用历史表：跨会话保留的调用记录（全局，不限项目）
        CREATE TABLE IF NOT EXISTS call_history (
            -- 记录 ID：自增主键
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            -- 被调用 Server 的节点 ID：仅作展示关联，不设外键（节点删除后历史仍保留）
            node_id INTEGER NOT NULL,
            -- Server 别名：冗余存储，节点删除后仍可读
            server_name TEXT NOT NULL DEFAULT '',
            -- 工具名称
            tool_name TEXT NOT NULL,
            -- 调用是否出错。枚举：0-正常；1-出错
            is_error INTEGER NOT NULL DEFAULT 0,
            -- MCP content 数组：JSON 字符串，原样透传
            content TEXT NOT NULL DEFAULT '[]',
            -- MCP 结构化结果：JSON 字符串，NULL 表示无
            structured_content TEXT,
            -- 入参快照：JSON 字符串
            arguments TEXT NOT NULL DEFAULT '',
            -- 调用耗时：毫秒
            duration_ms INTEGER NOT NULL DEFAULT 0,
            -- 调用时间：本地时间
            created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
        );

        COMMIT;
        "#,
    )?;
    // 增量迁移：projects.sync_dir、server_configs.envs/active_env（已存在时忽略报错）
    let _ = conn.execute(
        "ALTER TABLE projects ADD COLUMN sync_dir TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE server_configs ADD COLUMN envs TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE server_configs ADD COLUMN active_env TEXT",
        [],
    );
    Ok(())
}

/* ---------- 项目 ---------- */

/// 查询全部项目（按创建时间升序）。
pub fn list_projects(conn: &Connection) -> CmdResult<Vec<Project>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, created_at, updated_at, sync_dir FROM projects ORDER BY id ASC",
    )?;
    let rows = stmt.query_map([], map_project)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 行 -> Project 的映射函数。
fn map_project(row: &rusqlite::Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at: row.get(2)?,
        updated_at: row.get(3)?,
        sync_dir: row.get(4)?,
    })
}

/// 新建项目并返回带 ID 的完整对象。
///
/// # 参数
///
/// - `name`: 项目名称
/// - `sync_dir`: 同步绑定的 git 仓库目录；None 表示不开启同步
pub fn create_project(conn: &Connection, name: &str, sync_dir: Option<&str>) -> CmdResult<Project> {
    conn.execute(
        "INSERT INTO projects (name, sync_dir) VALUES (?1, ?2)",
        rusqlite::params![name, sync_dir],
    )?;
    let id = conn.last_insert_rowid();
    get_project(conn, id)
}

/// 按 ID 查询单个项目；不存在时报错。
pub fn get_project(conn: &Connection, id: i64) -> CmdResult<Project> {
    conn.query_row(
        "SELECT id, name, created_at, updated_at, sync_dir FROM projects WHERE id = ?1",
        rusqlite::params![id],
        map_project,
    )
    .map_err(|e| AppError::new(format!("项目不存在（id={id}）：{e}")))
}

/// 重命名项目。
pub fn rename_project(conn: &Connection, id: i64, name: &str) -> CmdResult<()> {
    let changed = conn.execute(
        "UPDATE projects SET name = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
        rusqlite::params![name, id],
    )?;
    if changed == 0 {
        return Err(AppError::new(format!("项目不存在（id={id}）")));
    }
    Ok(())
}

/// 更新项目同步目录（`None` 表示解除绑定），返回更新后的项目。
///
/// 目录本身由命令层先做校验/创建/git init（与创建项目时同一规则）。
pub fn update_project_sync_dir(
    conn: &Connection,
    id: i64,
    sync_dir: Option<&str>,
) -> CmdResult<Project> {
    let changed = conn.execute(
        "UPDATE projects SET sync_dir = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
        rusqlite::params![sync_dir, id],
    )?;
    if changed == 0 {
        return Err(AppError::new(format!("项目不存在（id={id}）")));
    }
    get_project(conn, id)
}

/// 删除项目（级联删除其全部树节点与配置）。
///
/// 返回该项目下全部 server 节点 ID，供上层先断开对应连接再删除。
pub fn delete_project(conn: &Connection, id: i64) -> CmdResult<Vec<i64>> {
    let server_ids = project_server_ids(conn, id)?;
    conn.execute("DELETE FROM projects WHERE id = ?1", rusqlite::params![id])?;
    Ok(server_ids)
}

/// 清空项目的全部树节点与配置（保留项目本身）。Git 同步导入覆盖用。
///
/// 返回被删除的 server 节点 ID 列表，供上层先断开对应连接。
pub fn delete_project_nodes(conn: &Connection, id: i64) -> CmdResult<Vec<i64>> {
    let server_ids = project_server_ids(conn, id)?;
    conn.execute(
        "DELETE FROM tree_nodes WHERE project_id = ?1",
        rusqlite::params![id],
    )?;
    Ok(server_ids)
}

/// 查询项目下全部 server 节点 ID。
fn project_server_ids(conn: &Connection, project_id: i64) -> CmdResult<Vec<i64>> {
    let mut stmt = conn
        .prepare("SELECT id FROM tree_nodes WHERE project_id = ?1 AND node_type = 'server'")?;
    let rows = stmt.query_map(rusqlite::params![project_id], |row| row.get::<_, i64>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/* ---------- 树节点 ---------- */

/// 查询项目下全部节点（扁平列表，前端组装树；LEFT JOIN 带出 server 的传输类型）。
pub fn list_nodes(conn: &Connection, project_id: i64) -> CmdResult<Vec<TreeNode>> {
    let mut stmt = conn.prepare(
        "SELECT t.id, t.project_id, t.parent_id, t.node_type, t.name, t.sort_order,
                t.created_at, t.updated_at, s.transport_type
         FROM tree_nodes t
         LEFT JOIN server_configs s ON s.node_id = t.id
         WHERE t.project_id = ?1
         ORDER BY t.sort_order ASC, t.id ASC",
    )?;
    let rows = stmt.query_map(rusqlite::params![project_id], map_node)?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 行 -> TreeNode 的映射函数（第 9 列为 LEFT JOIN 的传输类型，目录为 NULL）。
fn map_node(row: &rusqlite::Row<'_>) -> rusqlite::Result<TreeNode> {
    Ok(TreeNode {
        id: row.get(0)?,
        project_id: row.get(1)?,
        parent_id: row.get(2)?,
        node_type: node_type_from_str(&row.get::<_, String>(3)?),
        name: row.get(4)?,
        sort_order: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
        transport_type: row.get::<_, Option<String>>(8)?.map(|s| transport_from_str(&s)),
    })
}

/// 数据库字符串 -> NodeType（非法值直接报错，宁可失败也不静默）。
fn node_type_from_str(s: &str) -> NodeType {
    match s {
        "folder" => NodeType::Folder,
        "server" => NodeType::Server,
        other => panic!("tree_nodes.node_type 出现非法值：{other}"),
    }
}

/// 按 ID 查询节点；不存在时报错。
pub fn get_node(conn: &Connection, id: i64) -> CmdResult<TreeNode> {
    conn.query_row(
        "SELECT t.id, t.project_id, t.parent_id, t.node_type, t.name, t.sort_order,
                t.created_at, t.updated_at, s.transport_type
         FROM tree_nodes t
         LEFT JOIN server_configs s ON s.node_id = t.id
         WHERE t.id = ?1",
        rusqlite::params![id],
        map_node,
    )
    .map_err(|e| AppError::new(format!("节点不存在（id={id}）：{e}")))
}

/// 在指定父节点下创建目录或 Server 节点（排到同级末尾）。
///
/// # 参数
///
/// - `parent_id`: 父目录 ID；`None` 表示创建在项目根层。
/// - `node_type`: 节点类型（folder / server）。
/// - `name`: 目录名或 Server 别名。
pub fn create_node(
    conn: &Connection,
    project_id: i64,
    parent_id: Option<i64>,
    node_type: NodeType,
    name: &str,
) -> CmdResult<TreeNode> {
    // 父节点必须是本项目内的目录
    if let Some(pid) = parent_id {
        let parent = get_node(conn, pid)?;
        if parent.project_id != project_id {
            return Err(AppError::new("父目录不属于当前项目"));
        }
        if parent.node_type != NodeType::Folder {
            return Err(AppError::new("只能把节点挂在目录下，不能挂在 Server 下"));
        }
    }
    let type_str = node_type_to_str(node_type);
    let next_sort = next_sort_order(conn, parent_id)?;
    conn.execute(
        "INSERT INTO tree_nodes (project_id, parent_id, node_type, name, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![project_id, parent_id, type_str, name, next_sort],
    )?;
    get_node(conn, conn.last_insert_rowid())
}

/// NodeType -> 数据库字符串。
fn node_type_to_str(t: NodeType) -> &'static str {
    match t {
        NodeType::Folder => "folder",
        NodeType::Server => "server",
    }
}

/// 计算某个父节点下（或根层）的下一个排序序号。
fn next_sort_order(conn: &Connection, parent_id: Option<i64>) -> CmdResult<i64> {
    let max: Option<i64> = conn
        .query_row(
            "SELECT MAX(sort_order) FROM tree_nodes WHERE parent_id IS ?1",
            rusqlite::params![parent_id],
            |row| row.get(0),
        )
        .map_err(AppError::from)?;
    Ok(max.unwrap_or(-1) + 1)
}

/// 重命名节点。
pub fn rename_node(conn: &Connection, id: i64, name: &str) -> CmdResult<TreeNode> {
    let changed = conn.execute(
        "UPDATE tree_nodes SET name = ?1, updated_at = datetime('now','localtime') WHERE id = ?2",
        rusqlite::params![name, id],
    )?;
    if changed == 0 {
        return Err(AppError::new(format!("节点不存在（id={id}）")));
    }
    get_node(conn, id)
}

/// 复制节点：目录连同整棵子树（含各 Server 的连接配置）一起复制，副本排在同级末尾。
///
/// # 参数
///
/// - `node_id`: 待复制的源节点 ID。
/// - `new_name`: 副本根节点名称（前端生成，如「原目录-a3f2」）。
///
/// # 返回
///
/// 副本根节点。
///
/// # 异常
///
/// 源节点不存在或任一行写入失败时返回 [`AppError`]；复制全程在事务内进行，
/// 任一步失败整体回滚，不会留下半棵子树。
pub fn duplicate_node(conn: &Connection, node_id: i64, new_name: &str) -> CmdResult<TreeNode> {
    let src = get_node(conn, node_id)?;
    let tx = conn.unchecked_transaction()?;
    let new_id = copy_subtree(&tx, src.id, src.parent_id, Some(new_name))?;
    tx.commit()?;
    get_node(conn, new_id)
}

/// 递归复制单个子树，返回新节点 ID。
///
/// - `new_parent_id`: 副本挂载的父节点（根副本=沿用源父节点，子孙副本=其父的副本 ID）。
/// - `new_name`: 仅用于副本根节点（`None` 表示沿用原名）。
fn copy_subtree(
    conn: &Connection,
    src_id: i64,
    new_parent_id: Option<i64>,
    new_name: Option<&str>,
) -> CmdResult<i64> {
    let src = get_node(conn, src_id)?;
    let next_sort = next_sort_order(conn, new_parent_id)?;
    let name = new_name.unwrap_or(&src.name);
    conn.execute(
        "INSERT INTO tree_nodes (project_id, parent_id, node_type, name, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        rusqlite::params![
            src.project_id,
            new_parent_id,
            node_type_to_str(src.node_type),
            name,
            next_sort
        ],
    )?;
    let new_id = conn.last_insert_rowid();

    // server 节点：连带复制连接配置（无配置行则跳过）
    if src.node_type == NodeType::Server {
        conn.execute(
            "INSERT INTO server_configs
                    (node_id, transport_type, command, args, env, working_dir, url, headers,
                     timeout_ms, enabled, note, envs, active_env)
             SELECT ?1, transport_type, command, args, env, working_dir, url, headers,
                    timeout_ms, enabled, note, envs, active_env
             FROM server_configs WHERE node_id = ?2",
            rusqlite::params![new_id, src_id],
        )?;
    }

    // 子节点逐个复制（保持同级排序，父指向新副本）
    let mut stmt = conn.prepare(
        "SELECT id FROM tree_nodes WHERE parent_id = ?1 ORDER BY sort_order ASC, id ASC",
    )?;
    let child_ids = stmt
        .query_map(rusqlite::params![src_id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(stmt);
    for child_id in child_ids {
        copy_subtree(conn, child_id, Some(new_id), None)?;
    }
    Ok(new_id)
}

/// 移动节点到新的父目录（支持拖拽）。
///
/// 校验：目标父节点必须是目录；不能移动到自己或自己的后代里（防环）。
pub fn move_node(conn: &Connection, id: i64, new_parent_id: Option<i64>) -> CmdResult<TreeNode> {
    let node = get_node(conn, id)?;
    if let Some(pid) = new_parent_id {
        if pid == id {
            return Err(AppError::new("不能把节点移动到它自己下面"));
        }
        let parent = get_node(conn, pid)?;
        if parent.project_id != node.project_id {
            return Err(AppError::new("不能跨项目移动节点"));
        }
        if parent.node_type != NodeType::Folder {
            return Err(AppError::new("只能把节点移动到目录下"));
        }
        // 防环：新父节点不能是自己的后代
        if is_descendant(conn, pid, id)? {
            return Err(AppError::new("不能把目录移动到它自己的子目录里"));
        }
    }
    let next_sort = next_sort_order(conn, new_parent_id)?;
    conn.execute(
        "UPDATE tree_nodes
         SET parent_id = ?1, sort_order = ?2, updated_at = datetime('now','localtime')
         WHERE id = ?3",
        rusqlite::params![new_parent_id, next_sort, id],
    )?;
    get_node(conn, id)
}

/// 判断 `candidate` 是否为 `ancestor` 的后代（含间接后代）。
fn is_descendant(conn: &Connection, candidate: i64, ancestor: i64) -> CmdResult<bool> {
    let mut current = Some(candidate);
    let mut guard = 0;
    while let Some(cid) = current {
        if cid == ancestor {
            return Ok(true);
        }
        guard += 1;
        if guard > 10_000 {
            return Err(AppError::new("节点层级异常，疑似形成环"));
        }
        current = get_node(conn, cid)?.parent_id;
    }
    Ok(false)
}

/// 删除节点（递归级联删除全部后代与 server 配置）。
///
/// 返回被删掉的 server 节点 ID 列表，供上层断开对应连接。
pub fn delete_node(conn: &Connection, id: i64) -> CmdResult<Vec<i64>> {
    // 先收集全部后代中的 server 节点 ID（含自身）
    let mut stmt = conn.prepare(
        "WITH RECURSIVE sub(id, node_type) AS (
             SELECT id, node_type FROM tree_nodes WHERE id = ?1
             UNION ALL
             SELECT t.id, t.node_type FROM tree_nodes t JOIN sub s ON t.parent_id = s.id
         )
         SELECT id FROM sub WHERE node_type = 'server'",
    )?;
    let server_ids = stmt
        .query_map(rusqlite::params![id], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    conn.execute("DELETE FROM tree_nodes WHERE id = ?1", rusqlite::params![id])?;
    Ok(server_ids)
}

/* ---------- Server 配置 ---------- */

/// 读取某节点的 Server 配置；尚无配置时返回默认值。
pub fn get_server_config(conn: &Connection, node_id: i64) -> CmdResult<ServerConfig> {
    let result = conn.query_row(
        "SELECT node_id, transport_type, command, args, env, working_dir, url, headers,
                timeout_ms, enabled, note, envs, active_env
         FROM server_configs WHERE node_id = ?1",
        rusqlite::params![node_id],
        map_config,
    );
    match result {
        Ok(cfg) => Ok(cfg),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(ServerConfig {
            node_id,
            transport_type: TransportType::StreamableHttp,
            command: None,
            args: None,
            env: None,
            working_dir: None,
            url: None,
            headers: None,
            timeout_ms: 30_000,
            enabled: true,
            note: None,
            envs: None,
            active_env: None,
        }),
        Err(e) => Err(AppError::from(e)),
    }
}

/// 行 -> ServerConfig 的映射函数。
fn map_config(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServerConfig> {
    Ok(ServerConfig {
        node_id: row.get(0)?,
        transport_type: transport_from_str(&row.get::<_, String>(1)?),
        command: row.get(2)?,
        args: row.get(3)?,
        env: row.get(4)?,
        working_dir: row.get(5)?,
        url: row.get(6)?,
        headers: row.get(7)?,
        timeout_ms: row.get(8)?,
        enabled: row.get::<_, i64>(9)? != 0,
        note: row.get(10)?,
        envs: row.get(11)?,
        active_env: row.get(12)?,
    })
}

/// 数据库字符串 -> TransportType。
fn transport_from_str(s: &str) -> TransportType {
    match s {
        "stdio" => TransportType::Stdio,
        "streamable_http" => TransportType::StreamableHttp,
        other => panic!("server_configs.transport_type 出现非法值：{other}"),
    }
}

/// TransportType -> 数据库字符串。
fn transport_to_str(t: TransportType) -> &'static str {
    match t {
        TransportType::Stdio => "stdio",
        TransportType::StreamableHttp => "streamable_http",
    }
}

/// 保存（新增或更新）Server 配置。
///
/// 注意：调用方须先校验 node 是 server 类型节点。
pub fn upsert_server_config(conn: &Connection, cfg: &ServerConfig) -> CmdResult<()> {
    conn.execute(
        "INSERT INTO server_configs
             (node_id, transport_type, command, args, env, working_dir, url, headers,
              timeout_ms, enabled, note, envs, active_env)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
         ON CONFLICT(node_id) DO UPDATE SET
             transport_type = excluded.transport_type,
             command = excluded.command,
             args = excluded.args,
             env = excluded.env,
             working_dir = excluded.working_dir,
             url = excluded.url,
             headers = excluded.headers,
             timeout_ms = excluded.timeout_ms,
             enabled = excluded.enabled,
             note = excluded.note,
             envs = excluded.envs,
             active_env = excluded.active_env",
        rusqlite::params![
            cfg.node_id,
            transport_to_str(cfg.transport_type),
            cfg.command,
            cfg.args,
            cfg.env,
            cfg.working_dir,
            cfg.url,
            cfg.headers,
            cfg.timeout_ms,
            cfg.enabled as i64,
            cfg.note,
            cfg.envs,
            cfg.active_env,
        ],
    )?;
    Ok(())
}

/* ---------- 应用设置 ---------- */

/// 读取全部设置项。
pub fn get_all_settings(conn: &Connection) -> CmdResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings ORDER BY key ASC")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

/// 写入（新增或更新）一个设置项。
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> CmdResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        rusqlite::params![key, value],
    )?;
    Ok(())
}

/* ---------- 调用历史 ---------- */

/// 落盘保留的最大历史条数：比前端展示上限（200）多留余量。
const HISTORY_KEEP: i64 = 500;

/// 追加一条调用历史并裁剪总量（仅保留最新 [`HISTORY_KEEP`] 条）。
///
/// `record.id` 与 `record.created_at` 由后端生成，传入值会被忽略。
///
/// # 返回
///
/// 新记录的自增 ID（前端作为历史条目的展示编号：最新最大、跨会话稳定）。
///
/// # 异常
///
/// content / structured_content 序列化失败，或 SQLite 写入失败时返回 [`AppError`]。
pub fn insert_history(conn: &Connection, record: &HistoryRecord) -> CmdResult<i64> {
    let content = serde_json::to_string(&record.result.content)?;
    let structured = match &record.result.structured_content {
        Some(v) => Some(serde_json::to_string(v)?),
        None => None,
    };
    conn.execute(
        "INSERT INTO call_history
                (node_id, server_name, tool_name, is_error, content, structured_content,
                 arguments, duration_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![
            record.node_id,
            record.server_name,
            record.result.tool_name,
            record.result.is_error,
            content,
            structured,
            record.result.arguments,
            record.result.duration_ms
        ],
    )?;
    // 总量裁剪：防止表无限膨胀（大响应场景尤甚）
    conn.execute(
        "DELETE FROM call_history WHERE id NOT IN
                (SELECT id FROM call_history ORDER BY id DESC LIMIT ?1)",
        rusqlite::params![HISTORY_KEEP],
    )?;
    Ok(conn.last_insert_rowid())
}

/// 按时间倒序读取调用历史（分页：跳过 offset 条更旧的记录）。
///
/// # 参数
///
/// - `limit`: 本页最多返回条数。
/// - `offset`: 从第几条更旧的记录开始（前端动态加载翻页用，首页传 0）。
pub fn list_history(conn: &Connection, limit: i64, offset: i64) -> CmdResult<Vec<HistoryRecord>> {
    let mut stmt = conn.prepare(
        "SELECT id, node_id, server_name, tool_name, is_error, content,
                structured_content, arguments, duration_ms, created_at
         FROM call_history ORDER BY id DESC LIMIT ?1 OFFSET ?2",
    )?;
    let rows = stmt.query_map(rusqlite::params![limit, offset], map_history_row)?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 清空全部调用历史。
pub fn clear_history(conn: &Connection) -> CmdResult<()> {
    conn.execute("DELETE FROM call_history", [])?;
    Ok(())
}

/// 历史表行映射。SELECT 列序：
/// `id, node_id, server_name, tool_name, is_error, content, structured_content,
///  arguments, duration_ms, created_at`。
fn map_history_row(row: &rusqlite::Row) -> rusqlite::Result<HistoryRecord> {
    let content_raw: String = row.get(5)?;
    let structured_raw: Option<String> = row.get(6)?;
    let content: serde_json::Value = serde_json::from_str(&content_raw).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let structured_content = structured_raw
        .map(|s| {
            serde_json::from_str::<serde_json::Value>(&s).map_err(|e| {
                rusqlite::Error::FromSqlConversionFailure(6, rusqlite::types::Type::Text, Box::new(e))
            })
        })
        .transpose()?;
    Ok(HistoryRecord {
        id: row.get(0)?,
        node_id: row.get(1)?,
        server_name: row.get(2)?,
        created_at: row.get(9)?,
        result: CallResult {
            // seq 为前端会话内序号，落盘无意义，读取时置 0
            seq: 0,
            tool_name: row.get(3)?,
            is_error: row.get(4)?,
            content,
            structured_content,
            duration_ms: row.get(8)?,
            arguments: row.get(7)?,
        },
    })
}

/* ---------- 测试 ---------- */

#[cfg(test)]
mod tests {
    use super::*;

    /// 构造一个内存数据库（每个测试独立）。
    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn 项目与节点增删改查() {
        let conn = mem_db();
        let p = create_project(&conn, "演示项目", None).unwrap();
        let folder = create_node(&conn, p.id, None, NodeType::Folder, "目录A").unwrap();
        let sub = create_node(&conn, p.id, Some(folder.id), NodeType::Folder, "子目录A1").unwrap();
        let server = create_node(&conn, p.id, Some(sub.id), NodeType::Server, "文件服务器").unwrap();

        let nodes = list_nodes(&conn, p.id).unwrap();
        assert_eq!(nodes.len(), 3);

        // 保存配置
        let cfg = ServerConfig {
            node_id: server.id,
            transport_type: TransportType::Stdio,
            command: Some("npx".into()),
            args: Some(r#"["-y","@modelcontextprotocol/server-filesystem","/tmp"]"#.into()),
            env: Some(r#"{"DEBUG":"1"}"#.into()),
            working_dir: None,
            url: None,
            headers: None,
            timeout_ms: 15_000,
            enabled: true,
            note: Some("测试".into()),
            envs: None,
            active_env: None,
        };
        upsert_server_config(&conn, &cfg).unwrap();
        let got = get_server_config(&conn, server.id).unwrap();
        assert_eq!(got.command.as_deref(), Some("npx"));
        assert_eq!(got.timeout_ms, 15_000);

        // 删除子目录应级联删掉里面的 server
        let removed = delete_node(&conn, sub.id).unwrap();
        assert_eq!(removed, vec![server.id]);
        assert_eq!(list_nodes(&conn, p.id).unwrap().len(), 1);
    }

    #[test]
    fn 禁止把目录移动到自己的后代() {
        let conn = mem_db();
        let p = create_project(&conn, "p", None).unwrap();
        let a = create_node(&conn, p.id, None, NodeType::Folder, "a").unwrap();
        let b = create_node(&conn, p.id, Some(a.id), NodeType::Folder, "b").unwrap();
        // a 移到 b 下（b 是 a 的后代）应失败
        assert!(move_node(&conn, a.id, Some(b.id)).is_err());
        // b 移到根层应成功
        move_node(&conn, b.id, None).unwrap();
    }

    /// 复制目录：整棵子树与各 Server 配置一起复制，层级与配置内容保持一致。
    #[test]
    fn 复制目录连同子树和配置() {
        let conn = mem_db();
        let p = create_project(&conn, "p", None).unwrap();
        // 结构：目录A / 子目录A1 / 服务器S（配置含 envs）
        let a = create_node(&conn, p.id, None, NodeType::Folder, "目录A").unwrap();
        let sub = create_node(&conn, p.id, Some(a.id), NodeType::Folder, "子目录A1").unwrap();
        let server = create_node(&conn, p.id, Some(sub.id), NodeType::Server, "S").unwrap();
        let cfg = ServerConfig {
            node_id: server.id,
            transport_type: TransportType::Stdio,
            command: Some("npx".into()),
            args: Some(r#"["-y","demo"]"#.into()),
            env: Some(r#"{"DEBUG":"1"}"#.into()),
            working_dir: None,
            url: None,
            headers: None,
            timeout_ms: 15_000,
            enabled: true,
            note: None,
            envs: Some(r#"{"dev":{"env":{"TOKEN":"t"},"headers":{}}}"#.into()),
            active_env: Some("dev".into()),
        };
        upsert_server_config(&conn, &cfg).unwrap();

        // 复制目录A
        let copy = duplicate_node(&conn, a.id, "目录A-复制").unwrap();
        assert_eq!(copy.name, "目录A-复制");
        assert_eq!(copy.parent_id, None); // 根副本沿用原父层（根层）

        // 节点数：3 源 + 3 副本
        let nodes = list_nodes(&conn, p.id).unwrap();
        assert_eq!(nodes.len(), 6);

        // 副本层级：复制出的子目录父=副本根；复制出的 server 父=复制出的子目录
        let copy_sub = nodes
            .iter()
            .find(|n| n.parent_id == Some(copy.id))
            .expect("副本根下应有子目录");
        assert_eq!(copy_sub.name, "子目录A1");
        let copy_server = nodes
            .iter()
            .find(|n| n.parent_id == Some(copy_sub.id))
            .expect("副本子目录下应有 server");
        assert_ne!(copy_server.id, server.id);

        // 副本配置：内容与源一致（含 envs / active_env），但挂在新节点上
        let got = get_server_config(&conn, copy_server.id).unwrap();
        assert_eq!(got.command.as_deref(), Some("npx"));
        assert_eq!(got.timeout_ms, 15_000);
        assert_eq!(got.envs.as_deref(), cfg.envs.as_deref());
        assert_eq!(got.active_env.as_deref(), Some("dev"));

        // 源节点不受影响
        assert_eq!(get_server_config(&conn, server.id).unwrap().command.as_deref(), Some("npx"));
    }

    #[test]
    fn 删除项目返回其下全部server并级联删除() {
        let conn = mem_db();
        let p = create_project(&conn, "p", None).unwrap();
        let s1 = create_node(&conn, p.id, None, NodeType::Server, "s1").unwrap();
        let f = create_node(&conn, p.id, None, NodeType::Folder, "f").unwrap();
        let s2 = create_node(&conn, p.id, Some(f.id), NodeType::Server, "s2").unwrap();
        let mut ids = delete_project(&conn, p.id).unwrap();
        ids.sort();
        assert_eq!(ids, vec![s1.id, s2.id]);
        assert!(list_projects(&conn).unwrap().is_empty());
        assert!(list_nodes(&conn, p.id).unwrap().is_empty());
    }
}
