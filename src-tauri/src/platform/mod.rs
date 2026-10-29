//! 本机平台能力：路径解析、子进程、偏好文件、产品标识、系统钥匙串。

pub mod keyring_store;
pub mod paths;
#[cfg(feature = "tauri-runtime")]
pub mod preferences;
pub mod process;
pub mod product_identity;
