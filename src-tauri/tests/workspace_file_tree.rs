//! Workspace 文件树集成测试。

#[cfg(unix)]
#[test]
fn file_tree_survives_looping_dot_pi() {
    use std::os::unix::fs::symlink;
    use berth_lib::commands::workspace_files::{get_file_tree, FileTreeNode};

    let root = tempfile::tempdir().unwrap();
    let loop_path = root.path().join(".pi");
    symlink(".pi", &loop_path).unwrap();

    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let started = std::time::Instant::now();
    let tree = runtime
        .block_on(get_file_tree(
            root.path().to_string_lossy().into_owned(),
            Some(2),
        ))
        .expect("tree must not fail on ELOOP");
    assert!(
        started.elapsed() < std::time::Duration::from_secs(1),
        "classifying a looping symlink must not follow the whole chain"
    );

    let pi = tree
        .iter()
        .find(|node| match node {
            FileTreeNode::File { name, .. } | FileTreeNode::Dir { name, .. } => name == ".pi",
        })
        .expect(".pi still listed");
    match pi {
        FileTreeNode::File {
            name, link_target, ..
        } => {
            assert_eq!(name, ".pi");
            assert_eq!(link_target.as_deref(), Some(".pi"));
        }
        FileTreeNode::Dir { .. } => {
            panic!("looping directory symlink must not be treated as an expandable dir")
        }
    }
}
