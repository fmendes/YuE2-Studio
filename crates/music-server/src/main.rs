//! Standalone entry point for the studio service.
//!
//! The desktop application embeds `music_server::serve_on_port` directly; this binary
//! exists for development and for headless use.

use std::path::{Component, Path, PathBuf};

fn main() -> anyhow::Result<()> {
    if !music_engine::process_group::bind_children_to_this_process() {
        eprintln!("this process could not create its own job object; the engine is stopped by the supervisor only");
    }
    music_server::apply_saved_gpu();
    serve_built_interface();
    // the port is decided before the async workers start: deciding it can wait on netsh
    music_engine::yue_server::engine_port();
    let served = tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(music_server::serve());
    music_engine::process_group::terminate_group_members();
    served
}

/// Hands browsers the built interface (`npm --prefix app run build`), as the
/// desktop shell does with its bundled copy. `YUE_STUDIO_UI_DIR` points at
/// another build; the default is `app/dist` of this checkout.
fn serve_built_interface() {
    let dir = std::env::var_os("YUE_STUDIO_UI_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../app/dist"));
    if !dir.join("index.html").is_file() {
        eprintln!("no built interface at {}; run `npm --prefix app run build` to serve it", dir.display());
        return;
    }
    println!("serving the interface from {}", dir.display());
    music_server::set_asset_source(Box::new(move |path: &str| {
        let relative = Path::new(path);
        // plain names only: no `..`, no root, no drive
        if !relative.components().all(|part| matches!(part, Component::Normal(_))) {
            return None;
        }
        let bytes = std::fs::read(dir.join(relative)).ok()?;
        Some((bytes, media_type(path).to_string()))
    }));
}

fn media_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or_default().to_ascii_lowercase().as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}
