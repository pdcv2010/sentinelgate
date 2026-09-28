#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::Value;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};
use tokio::{fs::File, io::AsyncWriteExt};
use tokio_util::io::ReaderStream;
use uuid::Uuid;

#[derive(Serialize)]
struct FileInfo {
    path: String,
    name: String,
    size: u64,
    last_modified: u128,
}

#[derive(Serialize)]
struct ProtectResult {
    sha256: String,
    total_fragments: usize,
    fragment_paths: Vec<String>,
}

#[derive(Serialize)]
struct RestoreResult {
    sha256: String,
    output_path: String,
}

fn package_dir() -> Result<PathBuf, String> {
    env::current_exe().map_err(|e| format!("Cannot resolve Sentinel.exe location: {e}"))?
        .parent().map(Path::to_path_buf).ok_or_else(|| "Sentinel.exe has no parent directory".into())
}

fn temp_job_dir(kind: &str) -> Result<PathBuf, String> {
    let dir = env::temp_dir().join("SentinelGate").join(kind).join(Uuid::new_v4().to_string());
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create temporary work directory: {e}"))?;
    Ok(dir)
}

fn run_core(mode: &str, args: &[&str], password: &str) -> Result<Value, String> {
    let root = package_dir()?;
    let executable = root.join("sentinelgate.exe");
    if !executable.is_file() {
        return Err("The bundled C++ core sentinelgate.exe is missing.".into());
    }
    let runtime = root.join("runtime");
    let mut paths = vec![runtime.clone()];
    if let Some(existing) = env::var_os("PATH") { paths.extend(env::split_paths(&existing)); }
    let joined = env::join_paths(paths).map_err(|e| format!("Invalid runtime path: {e}"))?;
    let mut child = Command::new(executable)
        .current_dir(&root)
        .env("PATH", joined)
        .arg(mode)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn().map_err(|e| format!("Unable to start C++ core: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(password.as_bytes()).map_err(|e| format!("Unable to send password to C++ core: {e}"))?;
        stdin.write_all(b"\n").map_err(|e| format!("Unable to finish password input: {e}"))?;
    }
    let output = child.wait_with_output().map_err(|e| format!("Unable to read C++ core result: {e}"))?;
    let body = String::from_utf8_lossy(&output.stdout);
    let result: Value = serde_json::from_str(body.trim()).map_err(|_| {
        let detail = String::from_utf8_lossy(&output.stderr);
        if detail.trim().is_empty() { "C++ core returned invalid output.".to_string() } else { detail.trim().to_string() }
    })?;
    if !output.status.success() || result["status"] != "success" {
        return Err(result["message"].as_str().unwrap_or("C++ core operation failed.").to_string());
    }
    Ok(result)
}

#[tauri::command]
fn selected_file_info(paths: Vec<String>) -> Result<Vec<FileInfo>, String> {
    paths.into_iter().map(|path| {
        let file = PathBuf::from(&path);
        let meta = fs::metadata(&file).map_err(|e| format!("Cannot read selected file: {e}"))?;
        if !meta.is_file() { return Err("A selected path is not a regular file.".into()); }
        let name = file.file_name().and_then(|v| v.to_str()).ok_or("Invalid selected filename")?.to_string();
        Ok(FileInfo { path, name, size: meta.len(), last_modified: meta.modified().ok().and_then(|v| v.duration_since(std::time::UNIX_EPOCH).ok()).map(|v| v.as_millis()).unwrap_or_default() })
    }).collect()
}

#[tauri::command]
async fn download_track_audio(api_base: String, token: String, track_id: String) -> Result<String, String> {
    if track_id.is_empty() || !track_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') { return Err("Invalid music track identifier.".into()); }
    let url = format!("{}/music/tracks/{}/audio", api_base.trim_end_matches('/'), track_id);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let response = client.get(url).bearer_auth(token).send().await.map_err(|e| format!("Cannot download carrier audio: {e}"))?;
    if !response.status().is_success() { return Err(format!("Carrier audio request failed (HTTP {}).", response.status())); }
    let dir = temp_job_dir("audio")?;
    let path = dir.join("carrier-audio.bin");
    let mut file = File::create(&path).await.map_err(|e| e.to_string())?;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let bytes = chunk.map_err(|e| format!("Carrier audio transfer failed: {e}"))?;
        file.write_all(&bytes).await.map_err(|e| e.to_string())?;
    }
    file.flush().await.map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn protect_local_file(input_path: String, audio_path: String, password: String) -> Result<ProtectResult, String> {
    let dir = temp_job_dir("protect")?;
    let dir_text = dir.to_string_lossy().into_owned();
    let result = run_core("protect", &[&input_path, &audio_path, &dir_text], &password)?;
    let mut paths: Vec<PathBuf> = fs::read_dir(&dir).map_err(|e| e.to_string())?.filter_map(Result::ok).map(|e| e.path()).collect();
    paths.sort();
    Ok(ProtectResult {
        sha256: result["sha256"].as_str().ok_or("C++ core omitted SHA-256")?.to_string(),
        total_fragments: result["fragments"].as_u64().ok_or("C++ core omitted fragment count")? as usize,
        fragment_paths: paths.into_iter().map(|p| p.to_string_lossy().into_owned()).collect(),
    })
}

#[tauri::command]
async fn upload_fragment(api_base: String, token: String, job_id: String, file_index: usize, fragment_index: usize, fragment_path: String) -> Result<(), String> {
    let file = File::open(&fragment_path).await.map_err(|e| format!("Cannot open encrypted fragment: {e}"))?;
    let size = file.metadata().await.map_err(|e| e.to_string())?.len();
    let stream = ReaderStream::with_capacity(file, 64 * 1024);
    let body = reqwest::Body::wrap_stream(stream);
    let url = format!("{}/protection/client-jobs/{}/files/{}/fragments/{}", api_base.trim_end_matches('/'), job_id, file_index, fragment_index);
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let response = client.put(url).bearer_auth(token).header(reqwest::header::CONTENT_TYPE, "application/octet-stream").header(reqwest::header::CONTENT_LENGTH, size).body(body).send().await.map_err(|e| format!("Fragment upload failed: {e}"))?;
    if !response.status().is_success() { return Err(format!("Fragment upload rejected (HTTP {}).", response.status())); }
    Ok(())
}

#[tauri::command]
async fn download_fragments(api_base: String, token: String, job_id: String, file_index: usize, total_fragments: usize) -> Result<String, String> {
    if total_fragments == 0 || total_fragments > 256 { return Err("Invalid fragment count.".into()); }
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(600)).build().map_err(|e| e.to_string())?;
    let dir = temp_job_dir("restore")?;
    for index in 0..total_fragments {
        let url = format!("{}/protection/client-jobs/{}/files/{}/fragments/{}", api_base.trim_end_matches('/'), job_id, file_index, index);
        let response = client.get(url).bearer_auth(&token).send().await.map_err(|e| format!("Fragment download failed: {e}"))?;
        if !response.status().is_success() { return Err(format!("Server could not provide fragment {} (HTTP {}).", index, response.status())); }
        let mut output = File::create(dir.join(format!("fragment-{index}.bin"))).await.map_err(|e| e.to_string())?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            output.write_all(&chunk.map_err(|e| format!("Fragment transfer failed: {e}"))?).await.map_err(|e| e.to_string())?;
        }
        output.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn restore_local_fragments(fragment_dir: String, password: String) -> Result<RestoreResult, String> {
    let output_dir = temp_job_dir("output")?;
    let output_path = output_dir.join("restored.bin");
    let fragment_text = fragment_dir;
    let output_text = output_path.to_string_lossy().into_owned();
    let result = run_core("restore", &[&fragment_text, &output_text], &password)?;
    Ok(RestoreResult { sha256: result["sha256"].as_str().ok_or("C++ core omitted SHA-256")?.to_string(), output_path: output_text })
}

#[tauri::command]
fn remove_temp_path(path: String) -> Result<(), String> {
    let root = env::temp_dir().join("SentinelGate").canonicalize().map_err(|e| e.to_string())?;
    let candidate = PathBuf::from(path);
    let resolved = candidate.canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(&root) { return Err("Refusing to remove a path outside SentinelGate temporary storage.".into()); }
    if resolved.is_dir() { fs::remove_dir_all(resolved).map_err(|e| e.to_string()) }
    else { fs::remove_file(resolved).map_err(|e| e.to_string()) }
}

#[tauri::command]
fn copy_restored_file(source_path: String, destination_path: String) -> Result<(), String> {
    fs::copy(&source_path, &destination_path).map_err(|e| format!("Could not save restored file: {e}"))?;
    fs::remove_file(source_path).ok();
    Ok(())
}

#[tauri::command]
fn api_base_url() -> Result<String, String> {
    let path = package_dir()?.join("config.js");
    let source = fs::read_to_string(&path).map_err(|_| format!("Cannot read {}", path.display()))?;
    let server = source.lines().find_map(|line| {
        let line = line.trim();
        let value = line.strip_prefix("window.SERVER_URL")?.split_once('=')?.1.trim().trim_end_matches(';').trim();
        let value = value.strip_prefix('"')?.strip_suffix('"')?;
        Some(value.to_string())
    }).ok_or_else(|| format!("Set SERVER_URL in {}", path.display()))?;
    if server.contains('<') || !(server.starts_with("https://") || cfg!(debug_assertions) && server.starts_with("http://")) {
        return Err(format!("Set the production HTTPS SERVER_URL in {} before launching Sentinel.", path.display()));
    }
    Ok(format!("{}/api", server.trim_end_matches('/')))
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use std::os::windows::ffi::OsStrExt;
    let title: Vec<u16> = std::ffi::OsStr::new("SentinelGate").encode_wide().chain(Some(0)).collect();
    let text: Vec<u16> = std::ffi::OsStr::new(message).encode_wide().chain(Some(0)).collect();
    #[link(name = "user32")]
    unsafe extern "system" { fn MessageBoxW(hwnd: *mut std::ffi::c_void, text: *const u16, title: *const u16, kind: u32) -> i32; }
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), 0x10); }
}

#[cfg(windows)]
fn webview2_is_installed() -> bool {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let root = RegKey::predef(HKEY_LOCAL_MACHINE);
    for base in [r"SOFTWARE\Microsoft\EdgeUpdate\Clients", r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"] {
        if let Ok(clients) = root.open_subkey(base) {
            for key_name in clients.enum_keys().flatten() {
                if let Ok(key) = clients.open_subkey(key_name) {
                    let name: String = key.get_value("name").unwrap_or_default();
                    let version: String = key.get_value("pv").unwrap_or_default();
                    if name.to_ascii_lowercase().contains("webview2") && !version.is_empty() && version != "0.0.0.0" { return true; }
                }
            }
        }
    }
    false
}

#[cfg(windows)]
fn preflight() -> Result<(), String> {
    if !webview2_is_installed() {
        let setup = package_dir()?.join("runtime").join("MicrosoftEdgeWebview2Setup.exe");
        if !setup.is_file() { return Err("Microsoft Edge WebView2 Runtime is missing and its bundled installer was not found in runtime/.".into()); }
        let status = Command::new(setup).args(["/silent", "/install"]).status().map_err(|e| format!("Cannot install the required WebView2 runtime: {e}"))?;
        if !status.success() { return Err("WebView2 installation did not complete. Connect to the Internet and retry Sentinel.exe.".into()); }
    }
    Ok(())
}

fn main() {
    #[cfg(windows)]
    if let Err(error) = preflight() { show_startup_error(&error); return; }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![selected_file_info, download_track_audio, protect_local_file, upload_fragment, download_fragments, restore_local_fragments, copy_restored_file, remove_temp_path, api_base_url])
        .run(tauri::generate_context!())
        .expect("error while running SentinelGate desktop client");
}
