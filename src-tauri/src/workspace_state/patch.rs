//! 工作区事件的按路径补丁：文件变化只发变了的树节点与 git 条目。
//!
//! 每个 upsert 带它在新列表里的下标：保留下来的条目新旧相对顺序一致时，先删再按下标从小到大插入，
//! 结果与新列表逐项相同；顺序对不上（排序规则变化等）或条目过多就返回 `None`，调用方改发整份。

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use super::WorkspaceGitEntry;
use crate::commands::workspace_files::FileTreeNode;

/// 补丁条目（含 upsert 子树里的节点）超过这个数就整份发：切分支、批量生成文件时整份更省。
const PATCH_MAX_ITEMS: usize = 256;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TreeUpsert {
    /// 所在目录的相对路径，根为空串。
    pub parent: String,
    /// 在新的 `parent` 子项列表里的下标。
    pub index: usize,
    pub node: FileTreeNode,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct GitUpsert {
    pub index: usize,
    pub entry: WorkspaceGitEntry,
}

fn node_path(node: &FileTreeNode) -> &str {
    match node {
        FileTreeNode::File { path, .. } | FileTreeNode::Dir { path, .. } => path,
    }
}

fn children(node: &FileTreeNode) -> &[FileTreeNode] {
    match node {
        FileTreeNode::Dir { children, .. } => children,
        FileTreeNode::File { .. } => &[],
    }
}

fn count_nodes(node: &FileTreeNode) -> usize {
    1 + children(node).iter().map(count_nodes).sum::<usize>()
}

/// 两个目录除子项外都相同：只需往下比子项。
fn same_dir_shell(a: &FileTreeNode, b: &FileTreeNode) -> bool {
    match (a, b) {
        (
            FileTreeNode::Dir {
                name: an,
                path: ap,
                link_target: al,
                is_repo: ar,
                ignored: ai,
                ..
            },
            FileTreeNode::Dir {
                name: bn,
                path: bp,
                link_target: bl,
                is_repo: br,
                ignored: bi,
                ..
            },
        ) => an == bn && ap == bp && al == bl && ar == br && ai == bi,
        _ => false,
    }
}

/// 保留下来的条目在旧列表里的先后与新列表一致。
fn same_order<'a>(old: impl Iterator<Item = &'a str>, kept_in_new: &[&str]) -> bool {
    let kept: HashSet<&str> = kept_in_new.iter().copied().collect();
    old.filter(|path| kept.contains(path))
        .eq(kept_in_new.iter().copied())
}

pub(super) fn diff_tree(
    old: &[FileTreeNode],
    new: &[FileTreeNode],
) -> Option<(Vec<TreeUpsert>, Vec<String>)> {
    let mut upserts = Vec::new();
    let mut removals = Vec::new();
    let mut cost = 0;
    diff_children(old, new, "", &mut upserts, &mut removals, &mut cost)?;
    Some((upserts, removals))
}

fn diff_children(
    old: &[FileTreeNode],
    new: &[FileTreeNode],
    parent: &str,
    upserts: &mut Vec<TreeUpsert>,
    removals: &mut Vec<String>,
    cost: &mut usize,
) -> Option<()> {
    let old_by_path: HashMap<&str, &FileTreeNode> =
        old.iter().map(|node| (node_path(node), node)).collect();
    let new_paths: HashSet<&str> = new.iter().map(node_path).collect();
    for node in old {
        if !new_paths.contains(node_path(node)) {
            removals.push(node_path(node).to_owned());
            *cost += 1;
        }
    }
    let mut kept = Vec::new();
    for (index, node) in new.iter().enumerate() {
        match old_by_path.get(node_path(node)) {
            Some(previous) if *previous == node => kept.push(node_path(node)),
            Some(previous) if same_dir_shell(previous, node) => {
                kept.push(node_path(node));
                diff_children(
                    children(previous),
                    children(node),
                    node_path(node),
                    upserts,
                    removals,
                    cost,
                )?;
            }
            _ => {
                *cost += count_nodes(node);
                upserts.push(TreeUpsert {
                    parent: parent.to_owned(),
                    index,
                    node: node.clone(),
                });
            }
        }
        if *cost > PATCH_MAX_ITEMS {
            return None;
        }
    }
    same_order(old.iter().map(node_path), &kept).then_some(())
}

pub(super) fn diff_git(
    old: &[WorkspaceGitEntry],
    new: &[WorkspaceGitEntry],
) -> Option<(Vec<GitUpsert>, Vec<String>)> {
    let old_by_path: HashMap<&str, &WorkspaceGitEntry> = old
        .iter()
        .map(|entry| (entry.path.as_str(), entry))
        .collect();
    let new_paths: HashSet<&str> = new.iter().map(|entry| entry.path.as_str()).collect();
    let removals: Vec<String> = old
        .iter()
        .filter(|entry| !new_paths.contains(entry.path.as_str()))
        .map(|entry| entry.path.clone())
        .collect();
    let mut upserts = Vec::new();
    let mut kept = Vec::new();
    for (index, entry) in new.iter().enumerate() {
        if old_by_path.get(entry.path.as_str()) == Some(&entry) {
            kept.push(entry.path.as_str());
        } else {
            upserts.push(GitUpsert {
                index,
                entry: entry.clone(),
            });
        }
    }
    let fits = upserts.len() + removals.len() <= PATCH_MAX_ITEMS;
    (fits && same_order(old.iter().map(|entry| entry.path.as_str()), &kept))
        .then_some((upserts, removals))
}

/// 按新列表的下标插入；下标超出说明快照与补丁的基线不符。
fn insert_at<T>(list: &mut Vec<T>, index: usize, item: T) -> bool {
    if index > list.len() {
        return false;
    }
    list.insert(index, item);
    true
}

fn remove_path<T>(list: &mut Vec<T>, path: &str, key: impl Fn(&T) -> &str) -> bool {
    let Some(index) = list.iter().position(|item| key(item) == path) else {
        return false;
    };
    list.remove(index);
    true
}

/// `parent` 目录的子项列表；根为空串。
fn children_mut<'a>(
    nodes: &'a mut Vec<FileTreeNode>,
    parent: &str,
) -> Option<&'a mut Vec<FileTreeNode>> {
    if parent.is_empty() {
        return Some(nodes);
    }
    let on_the_way = |path: &str| {
        path == parent
            || parent
                .strip_prefix(path)
                .is_some_and(|rest| rest.starts_with('/'))
    };
    let index = nodes
        .iter()
        .position(|node| matches!(node, FileTreeNode::Dir { path, .. } if on_the_way(path)))?;
    let FileTreeNode::Dir { path, children, .. } = &mut nodes[index] else {
        return None;
    };
    if path.as_str() == parent {
        Some(children)
    } else {
        children_mut(children, parent)
    }
}

fn parent_of(path: &str) -> &str {
    path.rsplit_once('/').map_or("", |(parent, _)| parent)
}

/// 定位不到的条目返回 `false`（快照已与补丁的基线不符）。先删 removals 与所有 upsert 的旧条目，
/// 剩下的正好是保留的条目（相对顺序与新列表一致，见 `same_order`），再按下标从小到大插入；
/// 边删边插的话，后面才处理的同路径旧条目还在列表里，会把下标顶偏。
pub(super) fn apply_tree_patch(
    nodes: &mut Vec<FileTreeNode>,
    upserts: &[TreeUpsert],
    removals: &[String],
) -> bool {
    for path in removals {
        let Some(list) = children_mut(nodes, parent_of(path)) else {
            return false;
        };
        if !remove_path(list, path, node_path) {
            return false;
        }
    }
    for upsert in upserts {
        let Some(list) = children_mut(nodes, &upsert.parent) else {
            return false;
        };
        remove_path(list, node_path(&upsert.node), node_path);
    }
    for upsert in upserts {
        let Some(list) = children_mut(nodes, &upsert.parent) else {
            return false;
        };
        if !insert_at(list, upsert.index, upsert.node.clone()) {
            return false;
        }
    }
    true
}

pub(super) fn apply_git_patch(
    entries: &mut Vec<WorkspaceGitEntry>,
    upserts: &[GitUpsert],
    removals: &[String],
) -> bool {
    for path in removals {
        if !remove_path(entries, path, |entry| &entry.path) {
            return false;
        }
    }
    for upsert in upserts {
        remove_path(entries, &upsert.entry.path, |entry| &entry.path);
    }
    upserts
        .iter()
        .all(|upsert| insert_at(entries, upsert.index, upsert.entry.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str) -> FileTreeNode {
        FileTreeNode::File {
            name: path.rsplit('/').next().unwrap().to_owned(),
            path: path.to_owned(),
            link_target: None,
            ignored: false,
        }
    }

    fn dir(path: &str, children: Vec<FileTreeNode>) -> FileTreeNode {
        FileTreeNode::Dir {
            name: path.rsplit('/').next().unwrap().to_owned(),
            path: path.to_owned(),
            children,
            link_target: None,
            is_repo: false,
            ignored: false,
        }
    }

    fn git(path: &str, status: &str) -> WorkspaceGitEntry {
        WorkspaceGitEntry {
            path: path.to_owned(),
            status: status.to_owned(),
            additions: 1,
            deletions: 0,
        }
    }

    fn base() -> Vec<FileTreeNode> {
        vec![
            dir("docs", vec![file("docs/a.md"), file("docs/c.md")]),
            dir("src", vec![dir("src/lib", vec![]), file("src/main.rs")]),
            file("README.md"),
            file("z.txt"),
        ]
    }

    /// 补丁应用到旧树后与新树逐字段相同，并返回补丁条目数。
    fn roundtrip(old: Vec<FileTreeNode>, new: Vec<FileTreeNode>) -> usize {
        let (upserts, removals) = diff_tree(&old, &new).expect("patchable");
        let mut applied = old;
        assert!(apply_tree_patch(&mut applied, &upserts, &removals));
        assert_eq!(applied, new);
        upserts.len() + removals.len()
    }

    #[test]
    fn tree_patch_adds_a_file_in_place() {
        let mut new = base();
        new.insert(3, file("b.txt"));
        if let FileTreeNode::Dir { children, .. } = &mut new[0] {
            children.insert(1, file("docs/b.md"));
        }
        assert_eq!(roundtrip(base(), new), 2);
    }

    #[test]
    fn tree_patch_removes_a_file() {
        let mut new = base();
        new.remove(2);
        assert_eq!(roundtrip(base(), new), 1);
    }

    #[test]
    fn tree_patch_renames_a_file() {
        let mut new = base();
        if let FileTreeNode::Dir { children, .. } = &mut new[0] {
            children[1] = file("docs/b.md");
        }
        assert_eq!(roundtrip(base(), new), 2);
    }

    #[test]
    fn tree_patch_removes_a_whole_directory_with_one_entry() {
        let mut new = base();
        new.remove(1);
        let (upserts, removals) = diff_tree(&base(), &new).unwrap();
        assert!(upserts.is_empty());
        assert_eq!(removals, vec!["src".to_owned()]);
        roundtrip(base(), new);
    }

    #[test]
    fn tree_patch_replaces_a_node_whose_kind_changed() {
        let mut new = base();
        new.remove(3);
        new.insert(2, dir("z.txt", vec![file("z.txt/inner")]));
        roundtrip(base(), new);
    }

    #[test]
    fn tree_patch_reaches_nested_directories() {
        let mut new = base();
        if let FileTreeNode::Dir { children, .. } = &mut new[1] {
            children[0] = dir("src/lib", vec![file("src/lib/mod.rs")]);
        }
        let (upserts, _) = diff_tree(&base(), &new).unwrap();
        assert_eq!(upserts[0].parent, "src/lib");
        roundtrip(base(), new);
    }

    #[test]
    fn tree_patch_gives_up_on_large_changes_and_reordering() {
        let many: Vec<FileTreeNode> = (0..PATCH_MAX_ITEMS + 1)
            .map(|i| file(&format!("f{i:04}")))
            .collect();
        assert!(diff_tree(&[], &many).is_none());
        let mut swapped = base();
        swapped.swap(2, 3);
        assert!(diff_tree(&base(), &swapped).is_none());
    }

    #[test]
    fn git_patch_matches_new_status_list() {
        let old = vec![git("a.rs", "M"), git("b.rs", "M"), git("c.rs", "A")];
        let new = vec![git("a.rs", "M"), git("b.rs", "D"), git("bb.rs", "??")];
        let (upserts, removals) = diff_git(&old, &new).unwrap();
        assert_eq!(removals, vec!["c.rs".to_owned()]);
        assert_eq!(upserts.len(), 2);
        let mut applied = old;
        assert!(apply_git_patch(&mut applied, &upserts, &removals));
        assert_eq!(applied, new);
    }

    #[test]
    fn tree_patch_keeps_order_when_a_replaced_entry_moves_behind_an_insert() {
        // 验收反例：`rmdir a && touch a && mkdir l`，目录在前、按名字排。
        let old = vec![dir("a", vec![]), dir("k", vec![])];
        let new = vec![dir("k", vec![]), dir("l", vec![]), file("a")];
        let (upserts, _) = diff_tree(&old, &new).unwrap();
        assert_eq!(
            upserts.iter().map(|u| u.index).collect::<Vec<_>>(),
            vec![1, 2]
        );
        roundtrip(old, new);
    }

    #[test]
    fn apply_reports_a_patch_that_does_not_fit_the_snapshot() {
        let mut nodes = base();
        assert!(!apply_tree_patch(&mut nodes, &[], &["missing".to_owned()]));
        let upsert = TreeUpsert {
            parent: "nope".to_owned(),
            index: 0,
            node: file("nope/x"),
        };
        assert!(!apply_tree_patch(&mut nodes, &[upsert], &[]));
    }
}
