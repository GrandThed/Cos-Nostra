//! Small Win32 helpers shared by capture (conflict check), game detection, the session
//! watch and game art (exe icons).

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

/// File names of every running process, e.g. `cs2.exe`. One Toolhelp snapshot, which costs
/// about a millisecond, so it is cheap enough to take every second. Needs no handle to any
/// process, which matters for games behind a kernel anti-cheat.
pub fn running_executables() -> Result<Vec<String>> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    // Safety: the snapshot handle is closed on every path; the entry is sized as the API wants.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .context("taking a process snapshot")?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut names = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        names.push(String::from_utf16_lossy(&entry.szExeFile[..len]));
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    Ok(names)
}

/// Full image path of a running process whose file name is `executable` (case-insensitive),
/// e.g. `cs2.exe`. Tries every matching process until one answers; `None` when none runs or
/// none lets us query it. Only asks for the image name, never the process memory.
pub fn find_process_image_path(executable: &str) -> Option<String> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let wanted = executable.to_lowercase();
    // Safety: the snapshot handle is closed on every path; the entry is sized as the API wants.
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|e| log::debug!("process snapshot failed: {e}"))
        .ok()?;
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let mut pids = Vec::new();
    let mut more = unsafe { Process32FirstW(snapshot, &mut entry) }.is_ok();
    while more {
        let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
        if String::from_utf16_lossy(&entry.szExeFile[..len]).to_lowercase() == wanted {
            pids.push(entry.th32ProcessID);
        }
        more = unsafe { Process32NextW(snapshot, &mut entry) }.is_ok();
    }
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    pids.into_iter().find_map(|pid| {
        process_image_path(pid)
            .map_err(|e| log::debug!("image path for {executable} (pid {pid}) unavailable: {e:#}"))
            .ok()
    })
}

/// A decoded icon as straight (non-premultiplied) RGBA rows, top row first.
#[derive(Debug, Clone)]
pub struct IconImage {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The main icon of an executable, rendered at `size` pixels square (Windows picks the closest
/// image in the file and scales it). `Ok(None)` when the file has no icon resource, which is
/// how an exe without one is told apart from the generic default icon the shell would draw.
pub fn extract_exe_icon(path: &str, size: u32) -> Result<Option<IconImage>> {
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, PrivateExtractIconsW, HICON};

    let wide: Vec<u16> = path.encode_utf16().collect();
    if wide.is_empty() || wide.len() >= 260 {
        anyhow::bail!("path is empty or longer than MAX_PATH");
    }
    let mut file_name = [0u16; 260];
    file_name[..wide.len()].copy_from_slice(&wide);
    let mut icons = [HICON::default()];
    let mut id = 0u32;
    // Safety: the name is NUL-terminated inside its fixed buffer, the icon slice has room for
    // the one icon asked for, and the id out-param outlives the call.
    let extracted = unsafe {
        PrivateExtractIconsW(
            &file_name,
            0,
            size as i32,
            size as i32,
            Some(&mut icons),
            Some(&mut id),
            0,
        )
    };
    // 0 means no icons; 0xFFFFFFFF means the file could not be read.
    if extracted == 0 || extracted == u32::MAX || icons[0].is_invalid() {
        return Ok(None);
    }
    let icon = icons[0];
    let image = icon_to_rgba(icon);
    // Safety: the icon came from PrivateExtractIconsW and is destroyed exactly once.
    unsafe {
        let _ = DestroyIcon(icon);
    }
    image.map(Some)
}

fn icon_to_rgba(icon: windows::Win32::UI::WindowsAndMessaging::HICON) -> Result<IconImage> {
    use windows::Win32::Graphics::Gdi::{DeleteObject, GetObjectW, BITMAP};
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, ICONINFO};

    let mut info = ICONINFO::default();
    // Safety: `info` is a valid out-param; the bitmaps it receives are deleted below.
    unsafe { GetIconInfo(icon, &mut info) }.context("reading icon info")?;
    let result = (|| {
        if info.hbmColor.is_invalid() {
            anyhow::bail!("monochrome icon");
        }
        let mut bitmap = BITMAP::default();
        // Safety: the buffer is a BITMAP and its size is passed along.
        let read = unsafe {
            GetObjectW(
                info.hbmColor.into(),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut BITMAP as *mut core::ffi::c_void),
            )
        };
        if read == 0 {
            anyhow::bail!("reading the icon bitmap");
        }
        let (width, height) = (bitmap.bmWidth, bitmap.bmHeight.abs());
        if !(1..=1024).contains(&width) || !(1..=1024).contains(&height) {
            anyhow::bail!("unexpected icon size {width}x{height}");
        }
        let color = bitmap_bgra(info.hbmColor, width, height)?;
        let has_alpha = color.chunks_exact(4).any(|px| px[3] != 0);
        // Icons without an alpha channel carry transparency in the AND mask instead: a set
        // mask bit is a transparent pixel.
        let mask = if has_alpha || info.hbmMask.is_invalid() {
            None
        } else {
            bitmap_bgra(info.hbmMask, width, height).ok()
        };
        let mut rgba = Vec::with_capacity(color.len());
        for (i, px) in color.chunks_exact(4).enumerate() {
            let alpha = if has_alpha {
                px[3]
            } else {
                match &mask {
                    Some(mask) if mask[i * 4] != 0 => 0,
                    _ => 255,
                }
            };
            rgba.extend_from_slice(&[px[2], px[1], px[0], alpha]);
        }
        Ok(IconImage { width: width as u32, height: height as u32, rgba })
    })();
    // Safety: GetIconInfo hands ownership of both bitmaps to the caller.
    unsafe {
        if !info.hbmColor.is_invalid() {
            let _ = DeleteObject(info.hbmColor.into());
        }
        if !info.hbmMask.is_invalid() {
            let _ = DeleteObject(info.hbmMask.into());
        }
    }
    result
}

/// The first `height` rows of a bitmap as 32-bit top-down BGRA.
fn bitmap_bgra(
    bitmap: windows::Win32::Graphics::Gdi::HBITMAP,
    width: i32,
    height: i32,
) -> Result<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
    };

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            // Negative height asks for top-down rows.
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut pixels = vec![0u8; width as usize * height as usize * 4];
    // Safety: the screen DC is released below; the buffer holds exactly `height` rows of
    // 32-bit pixels, which is what the header asks GetDIBits to write, and 32-bit BI_RGB has
    // no colour table to overflow `bmiColors`.
    let rows = unsafe {
        let dc = GetDC(None);
        if dc.is_invalid() {
            anyhow::bail!("no screen device context");
        }
        let rows = GetDIBits(
            dc,
            bitmap,
            0,
            height as u32,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        ReleaseDC(None, dc);
        rows
    };
    if rows == 0 {
        anyhow::bail!("reading bitmap bits");
    }
    Ok(pixels)
}

/// An audio endpoint as the Settings screen lists it. `id` is the endpoint id OBS's WASAPI
/// sources take as `device_id`.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AudioDevice {
    pub id: String,
    pub name: String,
}

/// COM for the calling thread for as long as it lives. A thread that already has COM in
/// another mode keeps it, and is then not uninitialised here either.
struct Com(bool);

impl Com {
    fn init() -> Com {
        use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
        // Safety: paired with CoUninitialize in Drop only when this call succeeded.
        Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
    }
}

impl Drop for Com {
    fn drop(&mut self) {
        if self.0 {
            // Safety: balances the successful CoInitializeEx above, on the same thread.
            unsafe { windows::Win32::System::Com::CoUninitialize() };
        }
    }
}

fn device_enumerator() -> Result<windows::Win32::Media::Audio::IMMDeviceEnumerator> {
    use windows::Win32::Media::Audio::{IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_ALL};
    // Safety: a documented COM class, created on a thread with COM initialised.
    unsafe { CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL) }
        .context("creating the audio device enumerator")
}

/// The microphones (active capture endpoints) Windows knows, in its own order. Runs COM on the
/// calling thread, so call it off the UI thread.
pub fn microphones() -> Result<Vec<AudioDevice>> {
    use windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName;
    use windows::Win32::Media::Audio::{eCapture, DEVICE_STATE_ACTIVE};
    use windows::Win32::System::Com::{CoTaskMemFree, STGM_READ};

    let _com = Com::init();
    let enumerator = device_enumerator()?;
    let mut out = Vec::new();
    // Safety: every interface comes from the enumerator and is released when dropped; the id
    // string is freed with CoTaskMemFree as GetId requires.
    unsafe {
        let devices = enumerator
            .EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE)
            .context("listing capture devices")?;
        for i in 0..devices.GetCount().context("counting capture devices")? {
            let Ok(device) = devices.Item(i) else { continue };
            let Ok(raw_id) = device.GetId() else { continue };
            let id = raw_id.to_string();
            CoTaskMemFree(Some(raw_id.0 as *const core::ffi::c_void));
            let Ok(id) = id else { continue };
            let name = device
                .OpenPropertyStore(STGM_READ)
                .and_then(|store| store.GetValue(&PKEY_Device_FriendlyName))
                .map(|value| value.to_string())
                .unwrap_or_default();
            let name = if name.is_empty() { id.clone() } else { name };
            out.push(AudioDevice { id, name });
        }
    }
    Ok(out)
}

/// Executable names of the apps that have an audio session on the default output device right
/// now: whatever is playing, or has played, sound. That is the useful list to pick from when
/// choosing apps to record next to the game. This process is left out.
pub fn apps_with_audio() -> Result<Vec<String>> {
    use windows::core::Interface;
    use windows::Win32::Media::Audio::{eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2};
    use windows::Win32::System::Com::CLSCTX_ALL;

    let _com = Com::init();
    let enumerator = device_enumerator()?;
    let mut names: Vec<String> = Vec::new();
    // Safety: every interface is obtained from the one before it and released when dropped.
    unsafe {
        let device = enumerator
            .GetDefaultAudioEndpoint(eRender, eConsole)
            .context("finding the default output device")?;
        let manager: IAudioSessionManager2 = device
            .Activate(CLSCTX_ALL, None)
            .context("opening the audio sessions")?;
        let sessions = manager.GetSessionEnumerator().context("listing audio sessions")?;
        for i in 0..sessions.GetCount().context("counting audio sessions")? {
            let Ok(session) = sessions.GetSession(i) else { continue };
            let Ok(control) = session.cast::<IAudioSessionControl2>() else { continue };
            let Ok(pid) = control.GetProcessId() else { continue };
            // Pid 0 is the system sounds session.
            if pid == 0 || pid == std::process::id() {
                continue;
            }
            let Ok(path) = process_image_path(pid) else { continue };
            let Some(exe) = path.rsplit(['\\', '/']).next().map(str::to_string) else { continue };
            if !names.iter().any(|n| n.eq_ignore_ascii_case(&exe)) {
                names.push(exe);
            }
        }
    }
    names.sort_by_key(|n| n.to_lowercase());
    Ok(names)
}
