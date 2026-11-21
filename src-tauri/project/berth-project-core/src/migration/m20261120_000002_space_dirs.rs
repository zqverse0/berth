//! 空间数据搬出代码仓库：把每个空间主项目的 `.berth/` 复制到 `<数据目录>/spaces/<id>/`。
//!
//! - 只复制、不删除：仓库里的 `.berth/` 原样保留，由用户自己清理。
//! - 空间目录已存在就跳过（幂等）；先复制到 `<id>.tmp` 再改名，失败时不留半份。
//! - 跳过符号链接、套接字等非普通文件，以及旧的主项目标记 `local/hub.json`。
//! - 数据目录取库文件所在目录（`PRAGMA database_list`）；内存库没有目录，什么都不做。

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, DbBackend, Statement};

#[derive(DeriveMigrationName)]
pub struct Migration;

/// 与 `space::SPACES_DIR` 相同；迁移写死，不随代码改动。
const SPACES_DIR: &str = "spaces";

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let conn = manager.get_connection();
        let sql = |s: &str| Statement::from_string(DbBackend::Sqlite, s.to_owned());
        let file: String = conn
            .query_all(sql("PRAGMA database_list"))
            .await?
            .into_iter()
            .find(|row| row.try_get::<String>("", "name").is_ok_and(|name| name == "main"))
            .and_then(|row| row.try_get("", "file").ok())
            .unwrap_or_default();
        let Some(data_dir) = Path::new(&file).parent().filter(|_| !file.is_empty()) else {
            return Ok(());
        };
        let spaces = data_dir.join(SPACES_DIR);
        for row in conn
            .query_all(sql(
                "SELECT p.id, f.path FROM project p JOIN folder f ON f.id = p.main_folder_id",
            ))
            .await?
        {
            let id: i32 = row.try_get("", "id")?;
            let main: String = row.try_get("", "path")?;
            copy_space(&Path::new(&main).join(".berth"), &spaces, id)
                .map_err(|error| DbErr::Custom(format!("复制 {main}/.berth 到空间 {id} 失败：{error}")))?;
        }
        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        // 只复制、不改库：回退无事可做，空间目录留给用户处理。
        Ok(())
    }
}

fn copy_space(source: &Path, spaces: &Path, id: i32) -> io::Result<()> {
    let target = spaces.join(id.to_string());
    if !source.is_dir() || target.exists() {
        return Ok(());
    }
    let staging = spaces.join(format!("{id}.tmp"));
    if staging.exists() {
        fs::remove_dir_all(&staging)?;
    }
    let result = copy_tree(source, &staging, source).and_then(|()| fs::rename(&staging, &target));
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
    }
    result
}

fn copy_tree(from: &Path, to: &Path, root: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let path = entry.path();
        let dest: PathBuf = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&path, &dest, root)?;
        } else if kind.is_file() && path.strip_prefix(root).ok() != Some(Path::new("local/hub.json")) {
            fs::copy(&path, &dest)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_once_without_the_hub_marker() {
        let tmp = tempfile::tempdir().unwrap();
        let source = tmp.path().join("repo/.berth");
        fs::create_dir_all(source.join("tasks")).unwrap();
        fs::create_dir_all(source.join("local")).unwrap();
        fs::write(source.join("tasks/a.md"), "a").unwrap();
        fs::write(source.join("local/hub.json"), "{}").unwrap();
        fs::write(source.join("local/tasks.json"), "{}").unwrap();
        let spaces = tmp.path().join("spaces");

        copy_space(&source, &spaces, 7).unwrap();
        let target = spaces.join("7");
        assert_eq!(fs::read_to_string(target.join("tasks/a.md")).unwrap(), "a");
        assert!(target.join("local/tasks.json").is_file());
        assert!(!target.join("local/hub.json").exists());
        assert!(!spaces.join("7.tmp").exists());
        assert!(source.join("tasks/a.md").is_file());

        // 已有空间目录：不覆盖。
        fs::write(target.join("tasks/a.md"), "mine").unwrap();
        copy_space(&source, &spaces, 7).unwrap();
        assert_eq!(fs::read_to_string(target.join("tasks/a.md")).unwrap(), "mine");
        // 没有 `.berth/` 的空间什么都不建。
        copy_space(&tmp.path().join("none/.berth"), &spaces, 8).unwrap();
        assert!(!spaces.join("8").exists());
    }
}
