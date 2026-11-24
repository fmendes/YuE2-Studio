//! The studio computer's folders, for a browser.
//!
//! A system dialog opens on the computer that runs the studio, which is the
//! wrong screen for a browser on another one, and impossible for the service
//! run on its own (there is no window to own a dialog). So the page draws its
//! own folder and file picker and asks here what a folder holds. Every request
//! has come through the access guard already, like the rest of the service.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use axum::{extract::Query, http::StatusCode, Json};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{api_error, ApiError};

#[derive(Debug, Default, Deserialize)]
pub struct Browse {
    /// A full path; the home folder when left out.
    #[serde(default)]
    path: Option<String>,
    /// Files as well as folders, for picking a file.
    #[serde(default)]
    files: bool,
    /// Names that start with a dot.
    #[serde(default)]
    hidden: bool,
}

/// What a folder holds: its subfolders first, then (when asked) its files.
pub async fn list(Query(browse): Query<Browse>) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    tokio::task::spawn_blocking(move || listing(browse))
        .await
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .map(Json)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, format!("{error:#}")))
}

#[derive(Debug, Deserialize)]
pub struct NewFolder {
    /// The folder to make it in.
    path: String,
    name: String,
}

/// Makes a folder, for a picker asked where something should go.
pub async fn make(Json(new): Json<NewFolder>) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    tokio::task::spawn_blocking(move || -> Result<Value> {
        let name = new.name.trim();
        anyhow::ensure!(!name.is_empty() && name != "." && name != "..", "a folder needs a name");
        anyhow::ensure!(!name.contains(['/', '\\']) && !name.chars().any(char::is_control), "a folder name cannot hold / or \\");
        let parent = PathBuf::from(new.path.trim());
        anyhow::ensure!(parent.is_absolute(), "the folder must be a full path");
        let made = parent.join(name);
        std::fs::create_dir(&made).with_context(|| format!("make {}", made.display()))?;
        Ok(json!({ "path": shown(&made) }))
    })
    .await
    .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
    .map(Json)
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, format!("{error:#}")))
}

fn listing(browse: Browse) -> Result<Value> {
    let asked = match browse.path.as_deref().map(str::trim).filter(|path| !path.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => home().unwrap_or_else(|| PathBuf::from(std::path::MAIN_SEPARATOR_STR)),
    };
    anyhow::ensure!(asked.is_absolute(), "the folder must be a full path");
    let folder = plain(asked.canonicalize().with_context(|| format!("open {}", asked.display()))?);
    anyhow::ensure!(folder.is_dir(), "{} is not a folder", folder.display());
    let mut entries: Vec<(bool, String)> = Vec::new();
    for entry in std::fs::read_dir(&folder).with_context(|| format!("read {}", folder.display()))?.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !browse.hidden && name.starts_with('.') {
            continue;
        }
        // a link to a folder is a folder; a broken one is left out
        let Ok(meta) = std::fs::metadata(entry.path()) else { continue };
        if meta.is_dir() || (browse.files && meta.is_file()) {
            entries.push((meta.is_dir(), name));
        }
    }
    entries.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    Ok(json!({
        "path": shown(&folder),
        "parent": folder.parent().map(shown),
        "separator": std::path::MAIN_SEPARATOR_STR,
        "entries": entries.into_iter().map(|(dir, name)| json!({ "name": name, "dir": dir })).collect::<Vec<_>>(),
        "places": places(),
    }))
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).filter(|home| home.is_dir())
}

/// Where a picker starts from: home, the studio's data, the disks.
fn places() -> Vec<Value> {
    let mut places = Vec::new();
    let mut add = |name: String, path: &Path| {
        if path.is_dir() {
            places.push(json!({ "name": name, "path": shown(path) }));
        }
    };
    if let Some(home) = home() {
        add("Home".into(), &home);
    }
    if let Some(data) = crate::studio_data_root() {
        add("Studio data".into(), &data);
    }
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let drive = format!("{}:\\", letter as char);
        add(drive.clone(), Path::new(&drive));
    }
    #[cfg(not(windows))]
    {
        add("/".into(), Path::new("/"));
        // disks mounted where macOS and Linux put them
        let user = std::env::var("USER").unwrap_or_default();
        let mounts = ["/Volumes".to_string(), "/mnt".to_string(), "/media".to_string(), format!("/media/{user}"), format!("/run/media/{user}")];
        for mounts in mounts {
            let Ok(found) = std::fs::read_dir(&mounts) else { continue };
            let mut found: Vec<PathBuf> = found.flatten().map(|entry| entry.path()).filter(|path| path.is_dir()).collect();
            found.sort();
            for disk in found {
                if disk.to_string_lossy() == format!("/media/{user}") {
                    continue;
                }
                add(disk.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(), &disk);
            }
        }
    }
    places
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

/// A canonical Windows path without its `\\?\` prefix, which the rest of the
/// studio and the person would not recognise.
fn plain(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            if !rest.starts_with("UNC\\") {
                return PathBuf::from(rest);
            }
        }
    }
    path
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_folders_first_and_files_only_when_asked() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("beta")).unwrap();
        std::fs::create_dir(dir.path().join("Alpha")).unwrap();
        std::fs::create_dir(dir.path().join(".hidden")).unwrap();
        std::fs::write(dir.path().join("a.bin"), b"x").unwrap();
        let path = Some(dir.path().display().to_string());
        let folders = listing(Browse { path: path.clone(), files: false, hidden: false }).unwrap();
        let names: Vec<&str> = folders["entries"].as_array().unwrap().iter().map(|entry| entry["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["Alpha", "beta"]);
        let all = listing(Browse { path, files: true, hidden: true }).unwrap();
        let names: Vec<&str> = all["entries"].as_array().unwrap().iter().map(|entry| entry["name"].as_str().unwrap()).collect();
        assert_eq!(names, [".hidden", "Alpha", "beta", "a.bin"]);
        assert_eq!(all["entries"][3]["dir"], false);
    }

    #[test]
    fn refuses_a_relative_path_and_a_file() {
        assert!(listing(Browse { path: Some("relative/dir".into()), ..Browse::default() }).is_err());
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("f");
        std::fs::write(&file, b"x").unwrap();
        assert!(listing(Browse { path: Some(file.display().to_string()), ..Browse::default() }).is_err());
    }

    #[tokio::test]
    async fn makes_a_folder_and_refuses_a_path_for_a_name() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().display().to_string();
        let made = make(Json(NewFolder { path: parent.clone(), name: "new one".into() })).await.unwrap();
        assert!(dir.path().join("new one").is_dir());
        assert!(made.0["path"].as_str().unwrap().ends_with("new one"));
        assert!(make(Json(NewFolder { path: parent.clone(), name: "../escape".into() })).await.is_err());
        assert!(make(Json(NewFolder { path: parent, name: "..".into() })).await.is_err());
    }
}
