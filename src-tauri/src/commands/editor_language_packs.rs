use std::path::{Path, PathBuf};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256, Sha512};

use crate::app_error::{AppCommandError, AppErrorCode};

const MAX_PACK_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PACK_FILES: usize = 64;
const NPM_REGISTRY: &str = "https://registry.npmjs.org";
const PACK_API_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackEntry {
    pub id: String,
    pub version: String,
    pub display_name: String,
    pub extensions: Vec<String>,
    #[serde(default)]
    pub language_ids: Vec<String>,
    pub asset_url: String,
    pub signature_url: String,
    pub sha256: String,
    pub size: u64,
    pub editor_api_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub npm_package_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledLanguagePack {
    #[serde(flatten)]
    pub entry: LanguagePackEntry,
    pub enabled: bool,
    pub entry_path: String,
    #[serde(default = "default_pack_source")]
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrity: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackOperation {
    pub action: String,
    pub pack_id: Option<String>,
    pub query: Option<String>,
    pub package_name: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanguagePackSnapshot {
    pub catalog: Vec<LanguagePackEntry>,
    pub installed: Vec<InstalledLanguagePack>,
    pub catalog_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub catalog_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_source: Option<String>,
}

fn default_pack_source() -> String {
    "npm".to_string()
}

fn err(code: AppErrorCode, message: impl Into<String>) -> AppCommandError {
    AppCommandError::new(code, message)
}

fn safe_id(id: &str) -> Result<&str, AppCommandError> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err(err(AppErrorCode::InvalidInput, "Invalid language pack id"));
    }
    Ok(id)
}

fn pack_root(data_dir: &Path) -> PathBuf {
    data_dir.join("editor-language-packs")
}

async fn bounded_get(url: &str, max: usize) -> Result<Vec<u8>, AppCommandError> {
    if !url.starts_with("https://") {
        return Err(err(
            AppErrorCode::PermissionDenied,
            "Language pack URL must use HTTPS",
        ));
    }
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?
        .error_for_status()
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?;
    if response
        .content_length()
        .is_some_and(|size| size > max as u64)
    {
        return Err(err(
            AppErrorCode::ResourceCapacity,
            "Language pack download is too large",
        ));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?;
    if bytes.len() > max {
        return Err(err(
            AppErrorCode::ResourceCapacity,
            "Language pack download is too large",
        ));
    }
    Ok(bytes.to_vec())
}

fn installed(data_dir: &Path) -> Vec<InstalledLanguagePack> {
    let root = pack_root(data_dir);
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|entry| std::fs::read(entry.path().join("manifest.json")).ok())
        .filter_map(|bytes| serde_json::from_slice(&bytes).ok())
        .collect()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NpmLanguagePackManifest {
    id: String,
    display_name: String,
    extensions: Vec<String>,
    #[serde(default)]
    language_ids: Vec<String>,
    entry: String,
    editor_api_version: u32,
}

struct NpmPackMetadata {
    package_name: String,
    version: String,
    tarball: String,
    integrity: String,
    unpacked_size: u64,
    language: NpmLanguagePackManifest,
}

fn npm_package_url(package_name: &str) -> Result<reqwest::Url, AppCommandError> {
    let mut url = reqwest::Url::parse(NPM_REGISTRY)
        .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
    url.path_segments_mut()
        .map_err(|_| {
            err(
                AppErrorCode::ConfigurationInvalid,
                "Invalid npm registry URL",
            )
        })?
        .push(package_name);
    Ok(url)
}

async fn npm_metadata(package_name: &str) -> Result<NpmPackMetadata, AppCommandError> {
    if package_name.len() > 214
        || !(package_name.starts_with("berth-language-")
            || package_name.contains("/berth-language-"))
    {
        return Err(err(
            AppErrorCode::InvalidInput,
            "Package name must use the berth-language-* convention",
        ));
    }
    let response: serde_json::Value = reqwest::Client::new()
        .get(npm_package_url(package_name)?)
        .send()
        .await
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?
        .error_for_status()
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?
        .json()
        .await
        .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
    let version = response
        .pointer("/dist-tags/latest")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| {
            err(
                AppErrorCode::ConfigurationInvalid,
                "npm package has no latest version",
            )
        })?;
    let manifest = response
        .pointer(&format!(
            "/versions/{}",
            version.replace('~', "~0").replace('/', "~1")
        ))
        .ok_or_else(|| {
            err(
                AppErrorCode::ConfigurationInvalid,
                "npm package version is missing",
            )
        })?;
    let language: NpmLanguagePackManifest =
        serde_json::from_value(manifest.get("berthLanguagePack").cloned().ok_or_else(|| {
            err(
                AppErrorCode::ConfigurationInvalid,
                "Not a Berth language package",
            )
        })?)
        .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
    let dist = manifest.get("dist").ok_or_else(|| {
        err(
            AppErrorCode::ConfigurationInvalid,
            "npm package dist is missing",
        )
    })?;
    Ok(NpmPackMetadata {
        package_name: package_name.to_string(),
        version: version.to_string(),
        tarball: dist
            .get("tarball")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                err(
                    AppErrorCode::ConfigurationInvalid,
                    "npm tarball URL is missing",
                )
            })?
            .to_string(),
        integrity: dist
            .get("integrity")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                err(
                    AppErrorCode::ConfigurationInvalid,
                    "npm integrity is missing",
                )
            })?
            .to_string(),
        unpacked_size: dist
            .get("unpackedSize")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0),
        language,
    })
}

fn metadata_entry(metadata: &NpmPackMetadata) -> LanguagePackEntry {
    LanguagePackEntry {
        id: metadata.language.id.clone(),
        version: metadata.version.clone(),
        display_name: metadata.language.display_name.clone(),
        extensions: metadata.language.extensions.clone(),
        language_ids: metadata.language.language_ids.clone(),
        asset_url: metadata.tarball.clone(),
        signature_url: String::new(),
        sha256: String::new(),
        size: metadata.unpacked_size,
        editor_api_version: metadata.language.editor_api_version,
        npm_package_name: Some(metadata.package_name.clone()),
    }
}

async fn search_npm(query: &str) -> Result<Vec<LanguagePackEntry>, AppCommandError> {
    let response: serde_json::Value = reqwest::Client::new()
        .get(format!("{NPM_REGISTRY}/-/v1/search"))
        .query(&[
            ("text", format!("keywords:berth-language-pack {query}")),
            ("size", "20".to_string()),
        ])
        .send()
        .await
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?
        .error_for_status()
        .map_err(|error| err(AppErrorCode::NetworkError, error.to_string()))?
        .json()
        .await
        .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
    let names = response
        .get("objects")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|object| {
            object
                .pointer("/package/name")
                .and_then(serde_json::Value::as_str)
        })
        .filter(|name| name.starts_with("berth-language-") || name.contains("/berth-language-"))
        .take(12)
        .map(str::to_string)
        .collect::<Vec<_>>();
    Ok(stream::iter(names)
        .map(|name| async move { npm_metadata(&name).await.ok() })
        .buffer_unordered(6)
        .filter_map(|metadata| async move { metadata.map(|item| metadata_entry(&item)) })
        .collect()
        .await)
}

fn verify_npm_integrity(bytes: &[u8], integrity: &str) -> Result<(), AppCommandError> {
    let encoded = integrity.strip_prefix("sha512-").ok_or_else(|| {
        err(
            AppErrorCode::ConfigurationInvalid,
            "npm package must use sha512 integrity",
        )
    })?;
    let expected = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encoded)
        .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
    if Sha512::digest(bytes).as_slice() != expected.as_slice() {
        return Err(err(
            AppErrorCode::ConfigurationInvalid,
            "npm package integrity mismatch",
        ));
    }
    Ok(())
}

async fn install_npm(data_dir: &Path, package_name: &str) -> Result<(), AppCommandError> {
    let metadata = npm_metadata(package_name).await?;
    safe_id(&metadata.language.id)?;
    if metadata.language.editor_api_version != PACK_API_VERSION
        || metadata.unpacked_size > MAX_UNPACKED_BYTES
    {
        return Err(err(
            AppErrorCode::ConfigurationInvalid,
            "Incompatible language package",
        ));
    }
    let bytes = bounded_get(&metadata.tarball, MAX_PACK_BYTES).await?;
    verify_npm_integrity(&bytes, &metadata.integrity)?;
    let root = pack_root(data_dir);
    std::fs::create_dir_all(&root)
        .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    let staging = root.join(format!(".{}.staging", metadata.language.id));
    let target = root.join(&metadata.language.id);
    let backup = root.join(format!(".{}.backup", metadata.language.id));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(bytes.as_slice()));
    let mut file_count = 0usize;
    let mut total_size = 0u64;
    for item in archive
        .entries()
        .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?
    {
        let mut item =
            item.map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
        if !item.header().entry_type().is_file() {
            continue;
        }
        file_count += 1;
        total_size = total_size.saturating_add(item.size());
        if file_count > MAX_PACK_FILES || total_size > MAX_UNPACKED_BYTES {
            return Err(err(
                AppErrorCode::ResourceCapacity,
                "npm language package is too large",
            ));
        }
        let path = item
            .path()
            .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
        let relative = path.strip_prefix("package").map_err(|_| {
            err(
                AppErrorCode::ConfigurationInvalid,
                "Invalid npm archive path",
            )
        })?;
        if relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
        {
            continue;
        }
        let output = staging.join(relative);
        if let Some(parent) = output.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
        }
        item.unpack(&output)
            .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    }
    let entry_relative = Path::new(&metadata.language.entry);
    if entry_relative.is_absolute()
        || entry_relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(err(
            AppErrorCode::InvalidInput,
            "Invalid language package entry path",
        ));
    }
    let module_bytes = std::fs::read(staging.join(entry_relative)).map_err(|error| {
        err(
            AppErrorCode::ConfigurationInvalid,
            format!("Language entry is missing: {error}"),
        )
    })?;
    std::fs::write(staging.join("language.mjs"), &module_bytes)
        .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    let mut entry = metadata_entry(&metadata);
    entry.sha256 = format!("{:x}", Sha256::digest(&module_bytes));
    let installed = InstalledLanguagePack {
        entry,
        enabled: true,
        entry_path: target.join("language.mjs").to_string_lossy().into_owned(),
        source: "npm".to_string(),
        integrity: Some(metadata.integrity),
    };
    std::fs::write(
        staging.join("manifest.json"),
        serde_json::to_vec_pretty(&installed)
            .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?,
    )
    .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    let _ = std::fs::remove_dir_all(&backup);
    if target.exists() {
        std::fs::rename(&target, &backup)
            .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    }
    if let Err(error) = std::fs::rename(&staging, &target) {
        if backup.exists() {
            let _ = std::fs::rename(&backup, &target);
        }
        return Err(err(AppErrorCode::IoError, error.to_string()));
    }
    let _ = std::fs::remove_dir_all(backup);
    Ok(())
}

pub async fn editor_language_pack_operation_core(
    data_dir: &Path,
    operation: LanguagePackOperation,
) -> Result<LanguagePackSnapshot, AppCommandError> {
    let root = pack_root(data_dir);
    let installed_before = installed(data_dir);
    if operation.action == "search-npm" {
        let catalog = search_npm(operation.query.as_deref().unwrap_or_default()).await?;
        return Ok(LanguagePackSnapshot {
            catalog,
            installed: installed_before,
            catalog_status: "available".to_string(),
            catalog_error: None,
            module_source: None,
        });
    }
    if matches!(operation.action.as_str(), "install-npm" | "update-npm") {
        let package_name = operation
            .package_name
            .as_deref()
            .ok_or_else(|| err(AppErrorCode::InvalidInput, "npm package name is required"))?;
        install_npm(data_dir, package_name).await?;
        return Ok(LanguagePackSnapshot {
            catalog: Vec::new(),
            installed: installed(data_dir),
            catalog_status: "available".to_string(),
            catalog_error: None,
            module_source: None,
        });
    }
    if operation.action == "installed" {
        return Ok(LanguagePackSnapshot {
            catalog: Vec::new(),
            installed: installed_before,
            catalog_status: "unconfigured".to_string(),
            catalog_error: None,
            module_source: None,
        });
    }
    if operation.action == "load" {
        let id = safe_id(operation.pack_id.as_deref().unwrap_or_default())?;
        let manifest = installed_before
            .into_iter()
            .find(|pack| pack.entry.id == id && pack.enabled)
            .ok_or_else(|| err(AppErrorCode::NotFound, "Enabled language pack not found"))?;
        let module_bytes = std::fs::read(&manifest.entry_path)
            .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
        let digest = format!("{:x}", Sha256::digest(&module_bytes));
        if digest != manifest.entry.sha256.to_ascii_lowercase() {
            return Err(err(
                AppErrorCode::ConfigurationInvalid,
                "Installed language pack checksum mismatch",
            ));
        }
        let module_source = String::from_utf8(module_bytes)
            .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
        return Ok(LanguagePackSnapshot {
            catalog: Vec::new(),
            installed: installed(data_dir),
            catalog_status: "unconfigured".to_string(),
            catalog_error: None,
            module_source: Some(module_source),
        });
    }
    match operation.action.as_str() {
        "uninstall" => {
            let id = safe_id(operation.pack_id.as_deref().unwrap_or_default())?;
            let target = root.join(id);
            if target.exists() {
                std::fs::remove_dir_all(target)
                    .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
            }
        }
        "enable" | "disable" => {
            let id = safe_id(operation.pack_id.as_deref().unwrap_or_default())?;
            let manifest_path = root.join(id).join("manifest.json");
            let bytes = std::fs::read(&manifest_path)
                .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
            let mut manifest: InstalledLanguagePack = serde_json::from_slice(&bytes)
                .map_err(|error| err(AppErrorCode::ConfigurationInvalid, error.to_string()))?;
            manifest.enabled = operation.action == "enable";
            std::fs::write(
                manifest_path,
                serde_json::to_vec_pretty(&manifest)
                    .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?,
            )
            .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
        }
        _ => {
            return Err(err(
                AppErrorCode::InvalidInput,
                "Unknown language pack operation",
            ))
        }
    }
    Ok(LanguagePackSnapshot {
        catalog: Vec::new(),
        installed: installed(data_dir),
        catalog_status: "available".to_string(),
        catalog_error: None,
        module_source: None,
    })
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
pub async fn editor_language_pack_operation(
    app: tauri::AppHandle,
    operation: LanguagePackOperation,
) -> Result<LanguagePackSnapshot, AppCommandError> {
    use tauri::Manager;

    let fallback = app
        .path()
        .app_data_dir()
        .map_err(|error| err(AppErrorCode::IoError, error.to_string()))?;
    let data_dir = crate::platform::paths::resolve_effective_data_dir(&fallback);
    editor_language_pack_operation_core(&data_dir, operation).await
}

#[cfg(test)]
mod tests {
    use base64::Engine;
    use sha2::{Digest, Sha512};

    use super::{
        editor_language_pack_operation_core, safe_id, verify_npm_integrity, LanguagePackOperation,
    };

    #[test]
    fn pack_ids_cannot_escape_the_managed_directory() {
        assert!(safe_id("typescript").is_ok());
        assert!(safe_id("c_sharp-1").is_ok());
        assert!(safe_id("../escape").is_err());
        assert!(safe_id("nested/pack").is_err());
        assert!(safe_id("").is_err());
    }

    #[test]
    fn npm_integrity_rejects_modified_archives() {
        let bytes = b"language package";
        let integrity = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(Sha512::digest(bytes))
        );
        assert!(verify_npm_integrity(bytes, &integrity).is_ok());
        assert!(verify_npm_integrity(b"modified", &integrity).is_err());
    }

    #[tokio::test]
    async fn installed_lookup_never_requires_a_remote_catalog() {
        let data_dir = tempfile::tempdir().expect("temporary data directory");
        let snapshot = editor_language_pack_operation_core(
            data_dir.path(),
            LanguagePackOperation {
                action: "installed".to_string(),
                pack_id: None,
                query: None,
                package_name: None,
            },
        )
        .await
        .expect("local lookup should succeed");

        assert!(snapshot.catalog.is_empty());
        assert!(snapshot.installed.is_empty());
        assert_eq!(snapshot.catalog_status, "unconfigured");
    }
}
