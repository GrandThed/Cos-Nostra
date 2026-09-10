//! Small Win32 helpers shared by capture (conflict check) and game detection.

use anyhow::{Context, Result};
use windows::Win32::Foundation::HWND;

/// The window that currently has focus, with the process behind it.
#[derive(Debug, Clone)]
pub struct ForegroundWindow {
    pub pid: u32,
    /// File name of the process image, e.g. `game.exe`. Empty if it could not be read.
    pub executable: String,
    /// Full path of the process image, if it could be read.
    pub executable_path: Option<String>,
    pub title: String,
}

/// Returns `None` when there is no foreground window or it belongs to this process.
pub fn foreground_window() -> Option<ForegroundWindow> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

    // Safety: plain Win32 queries; the only pointer is the pid out-param below.
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_invalid() {
        return None;
    }
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    let executable_path = process_image_path(pid)
        .map_err(|e| log::debug!("image path for pid {pid} unavailable: {e:#}"))
        .ok();
    let executable = executable_path
        .as_deref()
        .and_then(|p| p.rsplit(['\\', '/']).next())
        .unwrap_or("")
        .to_string();
    Some(ForegroundWindow {
        pid,
        executable,
        executable_path,
        title: window_title(hwnd),
    })
}

/// Full path of the process image, e.g. `C:\Games\game.exe`.
pub fn process_image_path(pid: u32) -> Result<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    // Safety: the handle is closed on every path; the buffer outlives the call.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .context("opening process")?;
    let mut buf = vec![0u16; 1024];
    let mut len = buf.len() as u32;
    let queried = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            windows::core::PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
    };
    unsafe {
        let _ = CloseHandle(handle);
    }
    queried.context("querying process image name")?;
    Ok(String::from_utf16_lossy(&buf[..len as usize]))
}

pub fn window_title(hwnd: HWND) -> String {
    use windows::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut buf = [0u16; 512];
    // Safety: the buffer is valid for the call and Win32 bounds the copy by its length.
    let len = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize])
}
